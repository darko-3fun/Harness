// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Agent B reference target for the /audit rule engine and the /compile pipeline.
// This is the "hardened" shape every AAVE-*-0xx rule expects to find; it is NOT the generator's
// output. Agent A's real output replaces it once fixtures/sample-generated.json is published.
// Aave interfaces are declared inline so this file compiles with @openzeppelin/contracts alone.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPoolAddressesProviderMinimal {
    function getPool() external view returns (address);
    function getPriceOracle() external view returns (address);
}

interface IPoolMinimal {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

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

contract HardenedAaveFlashLoanReceiver is Ownable, ReentrancyGuard {
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
    IERC20 public immutable ASSET;

    bool private _inFlight;
    address private _premiumPayer;
    mapping(address => bool) public allowedRouters;

    error NotPool(address caller);
    error NotSelfInitiated(address initiator);
    error NotInFlight();
    error RouterNotAllowed(address router);
    error ReserveUnavailable(address asset);
    error ZeroLtvCollateral(address asset);
    error UnhealthyPosition(uint256 healthFactor);
    error IdleFundsForbidden(uint256 balance);
    error CannotSweepPrincipal(address token);

    constructor(address provider, address asset, address owner_) Ownable(owner_) {
        PROVIDER = IPoolAddressesProviderMinimal(provider);
        POOL = IPoolMinimal(PROVIDER.getPool());
        ASSET = IERC20(asset);
    }

    /// Frozen entrypoint name — harness-api/src/aave.ts drives /simulate through this signature.
    function executeFlashLoan(address asset, uint256 amount, bytes calldata params)
        external
        onlyOwner
        nonReentrant
    {
        _preflightReserve(asset);
        _assertNoIdleFunds(asset);

        _inFlight = true;
        _premiumPayer = msg.sender;
        POOL.flashLoanSimple(address(this), asset, amount, params, 0);
        _premiumPayer = address(0);
        _inFlight = false;

        _assertHealthy();
        _assertNoIdleFunds(asset);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        // AAVE-FL-001: all three gates. msg.sender alone is not enough — anyone may name this
        // contract as the receiver of their own flash loan.
        if (msg.sender != address(POOL)) revert NotPool(msg.sender);
        if (initiator != address(this)) revert NotSelfInitiated(initiator);
        if (!_inFlight) revert NotInFlight();

        // AAVE-FL-002: params carry a router selection only, never a call target plus calldata.
        if (params.length != 0) {
            address router = abi.decode(params, (address));
            if (!allowedRouters[router]) revert RouterNotAllowed(router);
        }

        // The premium is pulled from the initiator on demand rather than parked here, so the
        // contract stays balance-neutral between operations (AAVE-FL-013).
        uint256 owed = amount + premium;
        uint256 held = IERC20(asset).balanceOf(address(this));
        if (held < owed) {
            IERC20(asset).safeTransferFrom(_premiumPayer, address(this), owed - held);
        }

        // AAVE-DEP-015 / AAVE-FL-002: exact allowance for the pull, never an unbounded approval.
        IERC20(asset).forceApprove(address(POOL), owed);
        return true;
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        allowedRouters[router] = allowed;
    }

    /// AAVE-VLT-009: escape hatch for airdrops and stray tokens, never for the principal.
    function sweep(address token, address to) external onlyOwner {
        if (token == address(ASSET)) revert CannotSweepPrincipal(token);
        IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }

    /// AAVE-ORC-012: normalise the token decimals and the oracle base unit on both sides.
    function assetValueInBase(address asset, uint256 amount) public view returns (uint256) {
        IAaveOracleMinimal oracle = IAaveOracleMinimal(PROVIDER.getPriceOracle());
        uint256 price = _priceFor(oracle, asset);
        uint256 unit = 10 ** IERC20Metadata(asset).decimals();
        return (amount * price) / unit;
    }

    /// AAVE-ORC-007: an eMode category price source overrides the per-asset feed unless it is zero.
    function _priceFor(IAaveOracleMinimal oracle, address asset) private view returns (uint256) {
        uint8 category = uint8(POOL.getUserEMode(address(this)));
        if (category != 0) {
            address priceSource =
                IEModeSourceMinimal(address(oracle)).getEModeCategoryPriceSource(category);
            if (priceSource != address(0)) return oracle.getAssetPrice(priceSource);
        }
        return oracle.getAssetPrice(asset);
    }

    /// AAVE-RISK-006 and AAVE-RISK-010: read the config bitmap before touching the reserve.
    function _preflightReserve(address asset) private view {
        uint256 config = POOL.getConfiguration(asset);
        bool active = (config >> ACTIVE_BIT) & 1 == 1;
        bool frozen = (config >> FROZEN_BIT) & 1 == 1;
        bool paused = (config >> PAUSED_BIT) & 1 == 1;
        if (!active || frozen || paused) revert ReserveUnavailable(asset);

        uint256 ltv = config & LTV_MASK;
        if (ltv == 0) revert ZeroLtvCollateral(asset);
    }

    /// AAVE-RISK-010: zero means uncapped in Aave v3, so callers must read these, not assume them.
    function reserveCaps(address asset) external view returns (uint256 supplyCap, uint256 borrowCap) {
        uint256 config = POOL.getConfiguration(asset);
        supplyCap = (config >> SUPPLY_CAP_SHIFT) & CAP_MASK;
        borrowCap = (config >> BORROW_CAP_SHIFT) & CAP_MASK;
    }

    /// AAVE-RISK-005: never re-derive capacity — ask Aave and hold a floor above 1e18.
    function _assertHealthy() private view {
        (,,,,, uint256 healthFactor) = POOL.getUserAccountData(address(this));
        if (healthFactor < MIN_HEALTH_FACTOR) revert UnhealthyPosition(healthFactor);
    }

    /// AAVE-FL-013: idle balances let a third party repay their flash loan out of ours.
    function _assertNoIdleFunds(address asset) private view {
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        if (balanceBefore != 0) revert IdleFundsForbidden(balanceBefore);
    }
}
