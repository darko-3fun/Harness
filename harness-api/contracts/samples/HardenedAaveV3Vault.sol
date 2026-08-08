// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Agent B reference target for the VAULT preset — the shape every vault-applicable AAVE-*-0xx rule
// expects. Not the generator's output; Agent A's real output replaces it at h10.
// Aave interfaces are declared inline so this compiles with @openzeppelin/contracts alone.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IPoolAddressesProviderMinimal {
    function getPool() external view returns (address);
    function getPriceOracle() external view returns (address);
}

interface IPoolMinimal {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getReserveAToken(address asset) external view returns (address);
    function getConfiguration(address asset) external view returns (uint256 data);
    function getUserEMode(address user) external view returns (uint256);
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface IAaveOracleMinimal {
    function getAssetPrice(address asset) external view returns (uint256);
    function BASE_CURRENCY_UNIT() external view returns (uint256);
}

interface IEModeSourceMinimal {
    function getEModeCategoryPriceSource(uint8 id) external view returns (address priceSource);
}

interface IRewardsControllerMinimal {
    function claimAllRewards(address[] calldata assets, address to)
        external
        returns (address[] memory rewardsList, uint256[] memory claimedAmounts);
}

contract HardenedAaveV3Vault is ERC4626, Ownable, Pausable {
    using SafeERC20 for IERC20;

    uint256 private constant LTV_MASK = 0xFFFF;
    uint256 private constant CAP_MASK = (1 << 36) - 1;
    uint256 private constant ACTIVE_BIT = 56;
    uint256 private constant FROZEN_BIT = 57;
    uint256 private constant PAUSED_BIT = 60;
    uint256 private constant BORROW_CAP_SHIFT = 80;
    uint256 private constant SUPPLY_CAP_SHIFT = 116;
    uint256 private constant MIN_HEALTH_FACTOR = 1.05e18;

    IPoolAddressesProviderMinimal public immutable PROVIDER;
    IPoolMinimal public immutable POOL;
    IERC20 public immutable A_TOKEN;
    IRewardsControllerMinimal public immutable REWARDS;

    uint256 public depositCap;
    uint256 private _totalDeposited;

    error ReserveUnavailable(address asset);
    error ZeroLtvCollateral(address asset);
    error DepositCapExceeded(uint256 cap);
    error PartialWithdraw(uint256 requested, uint256 actual);
    error UnhealthyPosition(uint256 healthFactor);
    error CannotSweepPrincipal(address token);

    constructor(address provider, address asset_, address owner_, address rewards, uint256 cap)
        ERC20(
            string.concat("Harness Aave ", IERC20Metadata(asset_).symbol()),
            string.concat("h", IERC20Metadata(asset_).symbol())
        )
        ERC4626(IERC20(asset_))
        Ownable(owner_)
    {
        PROVIDER = IPoolAddressesProviderMinimal(provider);
        POOL = IPoolMinimal(PROVIDER.getPool());
        A_TOKEN = IERC20(POOL.getReserveAToken(asset_));
        REWARDS = IRewardsControllerMinimal(rewards);
        depositCap = cap;
    }

    /// aTokens rebase, so the vault's Aave position IS its assets. Donations are not detectable
    /// here and are neutralised by the virtual-share offset below rather than pretended away.
    function totalAssets() public view override returns (uint256) {
        return A_TOKEN.balanceOf(address(this));
    }

    /// AAVE-VLT-003 — the donation/first-depositor defence. Deleting this override is what makes
    /// an aToken donation profitable; aTokens are plain ERC20s, so the donation costs one transfer.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    function principalDeposited() external view returns (uint256) {
        return _totalDeposited;
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        _preflightReserve(asset());
        if (depositCap != 0 && totalAssets() + assets > depositCap) revert DepositCapExceeded(depositCap);

        super._deposit(caller, receiver, assets, shares);

        IERC20(asset()).forceApprove(address(POOL), assets);
        POOL.supply(asset(), assets, address(this), 0);
        _totalDeposited += assets;
    }

    /// AAVE-VLT-004 — Aave returns the amount ACTUALLY withdrawn. A capped, frozen, paused or
    /// illiquid reserve pays less than requested, and booking the request would credit phantom
    /// assets. AAVE-VLT-011 — super._withdraw keeps the caller/receiver/owner ordering intact:
    /// the allowance is spent against `owner_`, shares burn from `owner_`, assets go to `receiver`.
    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 actual = POOL.withdraw(asset(), assets, address(this));
        if (actual < assets) revert PartialWithdraw(assets, actual);

        _totalDeposited = _totalDeposited > assets ? _totalDeposited - assets : 0;
        super._withdraw(caller, receiver, owner_, assets, shares);
        _assertHealthy();
    }

    /// AAVE-VLT-008 — incentives need an explicit claim and must be passed the aTOKEN, not the
    /// underlying. Without this they accrue to a contract that can never move them.
    function claimRewards(address to) external onlyOwner returns (uint256[] memory claimed) {
        address[] memory assets = new address[](1);
        assets[0] = address(A_TOKEN);
        (, claimed) = REWARDS.claimAllRewards(assets, to);
    }

    /// AAVE-VLT-009 — escape hatch for airdrops and stray tokens, never for the principal.
    function sweep(address token, address to) external onlyOwner {
        if (token == asset() || token == address(A_TOKEN)) revert CannotSweepPrincipal(token);
        IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }

    function setDepositCap(uint256 cap) external onlyOwner {
        depositCap = cap;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// AAVE-RISK-010 — zero means uncapped in Aave v3, so callers must read these, not assume them.
    function reserveCaps() external view returns (uint256 supplyCap, uint256 borrowCap) {
        uint256 config = POOL.getConfiguration(asset());
        supplyCap = (config >> SUPPLY_CAP_SHIFT) & CAP_MASK;
        borrowCap = (config >> BORROW_CAP_SHIFT) & CAP_MASK;
    }

    /// AAVE-ORC-012 — normalise the token decimals and the oracle base unit on both sides.
    function assetValueInBase(uint256 amount) public view returns (uint256) {
        IAaveOracleMinimal oracle = IAaveOracleMinimal(PROVIDER.getPriceOracle());
        uint256 price = _priceFor(oracle, asset());
        uint256 unit = 10 ** IERC20Metadata(asset()).decimals();
        return (amount * price) / unit;
    }

    /// AAVE-ORC-007 — an eMode category price source overrides the per-asset feed unless it is zero.
    function _priceFor(IAaveOracleMinimal oracle, address asset_) private view returns (uint256) {
        uint8 category = uint8(POOL.getUserEMode(address(this)));
        if (category != 0) {
            address priceSource = IEModeSourceMinimal(address(oracle)).getEModeCategoryPriceSource(category);
            if (priceSource != address(0)) return oracle.getAssetPrice(priceSource);
        }
        return oracle.getAssetPrice(asset_);
    }

    /// AAVE-RISK-006 and AAVE-RISK-010 — read the config bitmap before touching the reserve.
    function _preflightReserve(address asset_) private view {
        uint256 config = POOL.getConfiguration(asset_);
        bool active = (config >> ACTIVE_BIT) & 1 == 1;
        bool frozen = (config >> FROZEN_BIT) & 1 == 1;
        bool paused = (config >> PAUSED_BIT) & 1 == 1;
        if (!active || frozen || paused) revert ReserveUnavailable(asset_);

        uint256 ltv = config & LTV_MASK;
        if (ltv == 0) revert ZeroLtvCollateral(asset_);
    }

    /// AAVE-RISK-005 — never re-derive capacity. Aave reports max uint when there is no debt.
    function _assertHealthy() private view {
        (, uint256 totalDebtBase,,,, uint256 healthFactor) = POOL.getUserAccountData(address(this));
        if (totalDebtBase > 0 && healthFactor < MIN_HEALTH_FACTOR) revert UnhealthyPosition(healthFactor);
    }
}
