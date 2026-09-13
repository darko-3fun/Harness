import { ContractBuilder, defineFunctions, setAccessControl, addPausable } from '@openzeppelin/wizard';

import {
  accessOf,
  gate,
  imp,
  print,
  throwIfInvalid,
  validateCommon,
  validateGatedFeatures,
  type ValidationMessages,
} from '@/generator/shared';
import { FINDING_IDS, IMPORT_PATHS, UINT_RE, type FindingId, type GenerateOptions } from '@/types';

/**
 * Fixed-price token sale (presale / IDO) paid in ETH.
 *
 * The shape is OpenZeppelin 2.x's RefundablePostDeliveryCrowdsale, which was the
 * right design and was removed from the library rather than fixed: funds are
 * escrowed until the sale closes, tokens are delivered only after a successful
 * close, and a failed close refunds. What the presale incidents of 2024–2026
 * were, and what this contract does about them:
 *
 *   LPAD-SALE-030  raised ETH was forwarded or withdrawable during the sale
 *                  (BetaPresale, May 2025: a mutable recipient plus instant
 *                  forwarding). Here nothing leaves until finalize() has run and
 *                  succeeded, and the destination is an immutable treasury.
 *   LPAD-SALE-031  tokens claimable before the sale had closed (AISOTH Presale,
 *                  June 2026: buy and claim in one transaction, dump into the
 *                  pool). Claims open only after a successful finalize, and each
 *                  wallet's claimed amount is tracked.
 *   LPAD-SALE-032  refunds pushed in a loop, or claim/refund reachable re-entrantly.
 *                  Everything here is pull-based under a reentrancy guard, with
 *                  effects before the transfer.
 *   LPAD-SALE-033  hard cap and per-wallet caps enforced on every contribution.
 *                  The per-wallet cap is friction, not security: it is sybil-able.
 *   LPAD-SALE-034  allowlist proofs bound to the caller: the Merkle leaf is the
 *                  sender, double-hashed per OpenZeppelin's guidance, and the root
 *                  lives on this contract, so a proof is worthless anywhere else.
 *   LPAD-SALE-035  token amounts derived from the token's own decimals, never
 *                  from an assumed 18 (Rova, Sherlock #537).
 *   LPAD-SALE-036  the sale books the tokens it actually received when funded,
 *                  and cannot finalize as successful unless it holds every token
 *                  it owes. A fee-on-transfer token cannot leave it insolvent.
 *   LPAD-SALE-037  vesting is nothing before the cliff, then linear; the maths is
 *                  in one view function the tests pin down at the boundaries.
 *
 * finalize() is permissionless once the window has closed: the outcome is a pure
 * function of state, so an owner cannot hold contributions hostage by never
 * calling it.
 */

function validate(opts: GenerateOptions): void {
  const messages: ValidationMessages = {};
  validateCommon(opts, messages);
  validateGatedFeatures(opts, messages);
  if (opts.access === 'none') {
    messages.access = 'A sale needs an owner to fund it and set the allowlist root';
  }
  const uintField = (key: keyof GenerateOptions, label: string, allowZero: boolean) => {
    const v = opts[key] as string | undefined;
    if (v === undefined || !UINT_RE.test(v)) messages[key] = `${label} must be a whole number of wei`;
    else if (!allowZero && v === '0') messages[key] = `${label} must be positive`;
  };
  uintField('tokenPriceWei', 'Token price', false);
  uintField('hardCapWei', 'Hard cap', false);
  uintField('softCapWei', 'Soft cap', true);
  uintField('minContributionWei', 'Minimum contribution', true);
  uintField('maxContributionWei', 'Maximum contribution', true);
  if (!messages.hardCapWei && !messages.softCapWei && BigInt(opts.softCapWei!) > BigInt(opts.hardCapWei!)) {
    messages.softCapWei = 'Soft cap cannot exceed the hard cap';
  }
  if (
    !messages.minContributionWei &&
    !messages.maxContributionWei &&
    opts.maxContributionWei !== '0' &&
    BigInt(opts.minContributionWei!) > BigInt(opts.maxContributionWei!)
  ) {
    messages.minContributionWei = 'Minimum contribution cannot exceed the per-wallet maximum';
  }
  const days = (key: keyof GenerateOptions, max: number) => {
    const v = opts[key] as number | undefined;
    if (v !== undefined && !(Number.isInteger(v) && v >= 0 && v <= max)) {
      messages[key] = `Must be an integer between 0 and ${max} days`;
    }
  };
  days('vestingCliffDays', 365);
  days('vestingDurationDays', 1460);
  throwIfInvalid(messages);
}

export function buildTokenSale(opts: GenerateOptions): {
  contract: ContractBuilder;
  appliedFindingIds: FindingId[];
} {
  validate(opts);

  const applied: FindingId[] = [];
  const c = new ContractBuilder(opts.name);
  c.license = 'MIT';

  c.addParent(imp('ReentrancyGuard', IMPORT_PATHS.REENTRANCY_GUARD));
  c.addImportOnly(imp('IERC20', IMPORT_PATHS.IERC20));
  c.addImportOnly(imp('IERC20Metadata', IMPORT_PATHS.IERC20_METADATA));
  c.addLibrary(imp('SafeERC20', IMPORT_PATHS.SAFE_ERC20), ['IERC20']);
  applied.push(FINDING_IDS.UNCHECKED_EXTERNAL_CALL);

  c.addNatspecTag('title', opts.name);
  c.addNatspecTag(
    'notice',
    'Fixed-price token sale generated by HARNESS. Contributions are escrowed until a permissionless finalize; a successful sale releases funds to an immutable treasury and tokens to contributors, a failed one refunds.',
  );

  addSaleConstructor(c, opts, applied);
  addFunding(c, opts, applied);
  addContribute(c, opts, applied);
  addFinalize(c, opts, applied);
  addClaimsAndRefunds(c, opts, applied);
  addSaleSurface(c, opts, applied);

  return { contract: c, appliedFindingIds: applied };
}

export function printTokenSale(opts: GenerateOptions): string {
  const { contract } = buildTokenSale(opts);
  return print(contract);
}

// ---------------------------------------------------------------------------

function addSaleConstructor(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  c.addConstructorArgument({ type: 'IERC20', name: 'token_' });
  c.addConstructorArgument({ type: 'uint64', name: 'start_' });
  c.addConstructorArgument({ type: 'uint64', name: 'end_' });
  c.addConstructorArgument({ type: 'address', name: 'treasury_' });

  c.addConstantOrImmutableOrErrorDefinition(
    `uint256 public constant TOKEN_PRICE_WEI = ${opts.tokenPriceWei};`,
    ['/// @notice Wei per one whole token (10 ** decimals units).'],
  );
  c.addConstantOrImmutableOrErrorDefinition(`uint256 public constant HARD_CAP_WEI = ${opts.hardCapWei};`);
  c.addConstantOrImmutableOrErrorDefinition(`uint256 public constant SOFT_CAP_WEI = ${opts.softCapWei};`, [
    '/// @notice Below this at close, the sale fails and every contribution is refundable.',
  ]);
  c.addConstantOrImmutableOrErrorDefinition(
    `uint256 public constant MIN_CONTRIBUTION_WEI = ${opts.minContributionWei};`,
  );
  c.addConstantOrImmutableOrErrorDefinition(
    `uint256 public constant MAX_CONTRIBUTION_WEI = ${opts.maxContributionWei};`,
    ['/// @notice Per wallet. Zero disables. LPAD-SALE-033 — friction, not security: it is sybil-able.'],
  );
  const cliff = opts.vestingCliffDays ?? 0;
  const duration = opts.vestingDurationDays ?? 0;
  c.addConstantOrImmutableOrErrorDefinition(`uint64 public constant VESTING_CLIFF = ${cliff} days;`);
  c.addConstantOrImmutableOrErrorDefinition(`uint64 public constant VESTING_DURATION = ${duration} days;`, [
    '/// @notice Linear after the cliff. Zero means everything unlocks at the cliff.',
  ]);

  c.addConstantOrImmutableOrErrorDefinition('IERC20 public immutable TOKEN;');
  c.addConstantOrImmutableOrErrorDefinition('uint256 public immutable TOKEN_UNIT;', [
    '/// @dev LPAD-SALE-035 — one whole token in raw units, read from the token itself.',
  ]);
  c.addConstantOrImmutableOrErrorDefinition('uint64 public immutable START;');
  c.addConstantOrImmutableOrErrorDefinition('uint64 public immutable END;');
  c.addConstantOrImmutableOrErrorDefinition('address public immutable TREASURY;', [
    '/// @notice LPAD-SALE-030 — where a successful raise goes. Immutable: no setter to hijack.',
  ]);

  c.addStateVariable('uint256 public totalRaised;', false);
  c.addStateVariable('uint256 public funded;', false);
  c.addStateVariable('bool public finalized;', false);
  c.addStateVariable('bool public succeeded;', false);
  c.addStateVariable('uint64 public finalizedAt;', false);
  c.addStateVariable('mapping(address contributor => uint256 weiContributed) public contributed;', false);
  c.addStateVariable('mapping(address contributor => uint256 tokensClaimed) public claimed;', false);

  c.addConstantOrImmutableOrErrorDefinition('error InvalidWindow(uint64 start, uint64 end);');
  c.addConstantOrImmutableOrErrorDefinition('error ZeroAddress();');

  c.addConstructorCode('if (end_ <= start_) revert InvalidWindow(start_, end_);');
  c.addConstructorCode('if (treasury_ == address(0) || address(token_) == address(0)) revert ZeroAddress();');
  c.addConstructorCode('TOKEN = token_;');
  c.addConstructorCode('TOKEN_UNIT = 10 ** IERC20Metadata(address(token_)).decimals();');
  c.addConstructorCode('START = start_;');
  c.addConstructorCode('END = end_;');
  c.addConstructorCode('TREASURY = treasury_;');

  applied.push(FINDING_IDS.SALE_PRICE_DECIMALS_MISMATCH);
  setAccessControl(c, accessOf(opts));

  const fns = defineFunctions({
    tokensFor: {
      kind: 'public',
      args: [{ type: 'uint256', name: 'weiAmount' }],
      returns: ['uint256'],
      mutability: 'view',
    },
    allocationOf: {
      kind: 'public',
      args: [{ type: 'address', name: 'contributor' }],
      returns: ['uint256'],
      mutability: 'view',
    },
  });
  c.setFunctionComments(
    [
      '/// @notice Tokens owed for `weiAmount`, floored.',
      '/// @dev LPAD-SALE-035 — scaled by the token\'s real decimals. A 6-decimal token and an',
      '/// @dev 18-decimal token priced identically receive the same number of whole tokens.',
    ],
    fns.tokensFor,
  );
  c.setFunctionBody(['return (weiAmount * TOKEN_UNIT) / TOKEN_PRICE_WEI;'], fns.tokensFor);
  c.setFunctionBody(['return tokensFor(contributed[contributor]);'], fns.allocationOf);
}

function addFunding(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  const fns = defineFunctions({
    fund: {
      kind: 'external',
      args: [{ type: 'uint256', name: 'amount' }],
      mutability: 'nonpayable',
    },
    tokensOwed: { kind: 'public', args: [], returns: ['uint256'], mutability: 'view' },
  });

  c.addConstantOrImmutableOrErrorDefinition('event Funded(uint256 requested, uint256 received);');

  c.setFunctionComments(
    [
      '/// @notice Deposit sale tokens. Call before finalize: a sale that does not hold what it',
      '/// @notice owes finalizes as failed and refunds.',
      '/// @dev LPAD-SALE-036 — books the amount that actually arrived, so a fee-on-transfer',
      '/// @dev token cannot leave the sale owing more than it holds.',
    ],
    fns.fund,
  );
  c.setFunctionBody(
    [
      'uint256 before = TOKEN.balanceOf(address(this));',
      'TOKEN.safeTransferFrom(msg.sender, address(this), amount);',
      'uint256 received = TOKEN.balanceOf(address(this)) - before;',
      'funded += received;',
      'emit Funded(amount, received);',
    ],
    fns.fund,
  );
  c.addModifier('nonReentrant', fns.fund);
  gate(c, fns.fund, opts, 'SALE_ADMIN', undefined);

  c.setFunctionComments(['/// @notice Every token contributors are owed at the current raise.'], fns.tokensOwed);
  c.setFunctionBody(['return tokensFor(totalRaised);'], fns.tokensOwed);

  applied.push(FINDING_IDS.SALE_FEE_ON_TRANSFER_TOKEN);
}

function addContribute(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  const fns = defineFunctions({
    contribute: {
      kind: 'external',
      args: [{ type: 'bytes32[] calldata', name: 'proof' }],
      mutability: 'payable',
    },
  });

  c.addConstantOrImmutableOrErrorDefinition('error SaleNotOpen(uint64 start, uint64 end);');
  c.addConstantOrImmutableOrErrorDefinition('error ContributionTooSmall(uint256 min);');
  c.addConstantOrImmutableOrErrorDefinition('error ContributionTooLarge(uint256 max);');
  c.addConstantOrImmutableOrErrorDefinition('error HardCapExceeded(uint256 remaining);');
  c.addConstantOrImmutableOrErrorDefinition(
    'event Contributed(address indexed contributor, uint256 amount, uint256 totalRaised);',
  );

  const body: string[] = [
    'if (finalized || block.timestamp < START || block.timestamp >= END) revert SaleNotOpen(START, END);',
  ];

  if (opts.whitelist) {
    c.addImportOnly(imp('MerkleProof', IMPORT_PATHS.MERKLE_PROOF));
    c.addStateVariable('bytes32 public merkleRoot;', false);
    c.addConstantOrImmutableOrErrorDefinition('error NotWhitelisted(address account);');
    c.addConstantOrImmutableOrErrorDefinition('error RootLocked();');
    c.addConstantOrImmutableOrErrorDefinition('event MerkleRootSet(bytes32 root);');

    body.push(
      '// LPAD-SALE-034 — the leaf is the caller, so a proof cannot be replayed by anyone',
      '// else, and the root is this contract\'s, so it cannot be replayed on another sale.',
      '// Double-hashed per OpenZeppelin: a 64-byte leaf would collide with an inner node.',
      'bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));',
      'if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert NotWhitelisted(msg.sender);',
    );

    const root = defineFunctions({
      setMerkleRoot: {
        kind: 'external',
        args: [{ type: 'bytes32', name: 'root' }],
        mutability: 'nonpayable',
      },
    });
    c.setFunctionComments(
      ['/// @notice Set the allowlist. Locked once the sale opens, so the terms cannot move under contributors.'],
      root.setMerkleRoot,
    );
    c.setFunctionBody(
      ['if (block.timestamp >= START) revert RootLocked();', 'merkleRoot = root;', 'emit MerkleRootSet(root);'],
      root.setMerkleRoot,
    );
    gate(c, root.setMerkleRoot, opts, 'SALE_ADMIN', undefined);
    applied.push(FINDING_IDS.SALE_WHITELIST_REPLAY);
  } else {
    body.push('proof; // no allowlist on this sale');
  }

  body.push(
    '',
    '// LPAD-SALE-033 — caps. The hard cap is a hard revert rather than a partial fill,',
    '// so the amount a contributor is charged is always the amount they sent.',
    'if (msg.value < MIN_CONTRIBUTION_WEI || tokensFor(msg.value) == 0) revert ContributionTooSmall(MIN_CONTRIBUTION_WEI);',
    'uint256 total = contributed[msg.sender] + msg.value;',
    'if (MAX_CONTRIBUTION_WEI != 0 && total > MAX_CONTRIBUTION_WEI) revert ContributionTooLarge(MAX_CONTRIBUTION_WEI);',
    'if (totalRaised + msg.value > HARD_CAP_WEI) revert HardCapExceeded(HARD_CAP_WEI - totalRaised);',
    '',
    'contributed[msg.sender] = total;',
    'totalRaised += msg.value;',
    'emit Contributed(msg.sender, msg.value, totalRaised);',
  );

  c.setFunctionComments(
    [
      '/// @notice Contribute ETH. The ETH is escrowed here until finalize() (LPAD-SALE-030).',
      '/// @param proof Merkle proof for msg.sender when the sale has an allowlist; empty otherwise.',
    ],
    fns.contribute,
  );
  c.setFunctionBody(body, fns.contribute);
  c.addModifier('nonReentrant', fns.contribute);
  applied.push(FINDING_IDS.SALE_CAPS_UNENFORCED);

  if (opts.pausable) {
    addPausable(c, accessOf(opts), [fns.contribute]);
    applied.push(FINDING_IDS.RISK_CAPS_AND_PAUSE_REVERTS);
  }
}

function addFinalize(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  const fns = defineFunctions({
    finalize: { kind: 'external', args: [], mutability: 'nonpayable' },
    cancel: { kind: 'external', args: [], mutability: 'nonpayable' },
    withdrawRaised: { kind: 'external', args: [], mutability: 'nonpayable' },
    withdrawUnsold: { kind: 'external', args: [], mutability: 'nonpayable' },
  });

  c.addConstantOrImmutableOrErrorDefinition('error AlreadyFinalized();');
  c.addConstantOrImmutableOrErrorDefinition('error NotFinalized();');
  c.addConstantOrImmutableOrErrorDefinition('error StillOpen(uint64 end);');
  c.addConstantOrImmutableOrErrorDefinition('error SaleFailed();');
  c.addConstantOrImmutableOrErrorDefinition('error SaleSucceeded();');
  c.addConstantOrImmutableOrErrorDefinition('error EthTransferFailed(address to, uint256 amount);');
  c.addConstantOrImmutableOrErrorDefinition(
    'event Finalized(bool succeeded, uint256 totalRaised, uint256 tokensOwed, uint256 funded);',
  );
  c.addConstantOrImmutableOrErrorDefinition('event RaisedWithdrawn(address indexed treasury, uint256 amount);');
  c.addConstantOrImmutableOrErrorDefinition('event UnsoldWithdrawn(address indexed treasury, uint256 amount);');

  c.setFunctionComments(
    [
      '/// @notice Close the sale. Permissionless once the window has ended or the hard cap is',
      '/// @notice reached: the outcome is a pure function of state, so nobody can sit on it.',
      '/// @dev Succeeds only if the soft cap was met AND the sale holds every token it owes',
      '/// @dev (LPAD-SALE-036). Otherwise it fails and every contribution becomes refundable.',
    ],
    fns.finalize,
  );
  c.setFunctionBody(
    [
      'if (finalized) revert AlreadyFinalized();',
      'if (block.timestamp < END && totalRaised < HARD_CAP_WEI) revert StillOpen(END);',
      '',
      'uint256 owed = tokensFor(totalRaised);',
      'finalized = true;',
      'finalizedAt = uint64(block.timestamp);',
      'succeeded = totalRaised >= SOFT_CAP_WEI && funded >= owed;',
      'emit Finalized(succeeded, totalRaised, owed, funded);',
    ],
    fns.finalize,
  );

  c.setFunctionComments(
    ['/// @notice Abort before the sale closes. Every contribution becomes refundable.'],
    fns.cancel,
  );
  c.setFunctionBody(
    [
      'if (finalized) revert AlreadyFinalized();',
      'finalized = true;',
      'finalizedAt = uint64(block.timestamp);',
      'emit Finalized(false, totalRaised, tokensFor(totalRaised), funded);',
    ],
    fns.cancel,
  );
  gate(c, fns.cancel, opts, 'SALE_ADMIN', undefined);

  c.setFunctionComments(
    [
      '/// @notice Release the raise to the treasury. LPAD-SALE-030 — only after a successful',
      '/// @notice finalize, only to the immutable treasury, and anyone may trigger it.',
    ],
    fns.withdrawRaised,
  );
  c.setFunctionBody(
    [
      'if (!finalized) revert NotFinalized();',
      'if (!succeeded) revert SaleFailed();',
      'uint256 amount = address(this).balance;',
      'emit RaisedWithdrawn(TREASURY, amount);',
      '_sendEth(TREASURY, amount);',
    ],
    fns.withdrawRaised,
  );
  c.addModifier('nonReentrant', fns.withdrawRaised);

  c.setFunctionComments(
    [
      '/// @notice Return tokens the sale no longer needs: the unsold remainder after a',
      '/// @notice successful sale, or everything after a failed one.',
    ],
    fns.withdrawUnsold,
  );
  c.setFunctionBody(
    [
      'if (!finalized) revert NotFinalized();',
      'uint256 keep = succeeded ? tokensFor(totalRaised) : 0;',
      'uint256 amount = funded - keep;',
      'funded = keep;',
      'emit UnsoldWithdrawn(TREASURY, amount);',
      'TOKEN.safeTransfer(TREASURY, amount);',
    ],
    fns.withdrawUnsold,
  );
  c.addModifier('nonReentrant', fns.withdrawUnsold);
  gate(c, fns.withdrawUnsold, opts, 'SALE_ADMIN', undefined);

  const send = defineFunctions({
    _sendEth: {
      kind: 'internal',
      args: [
        { type: 'address', name: 'to' },
        { type: 'uint256', name: 'amount' },
      ],
      mutability: 'nonpayable',
    },
  });
  c.setFunctionComments(
    ['/// @dev call(), never transfer(): a 2300-gas stipend strands contract recipients.'],
    send._sendEth,
  );
  c.setFunctionBody(
    ['(bool ok,) = to.call{value: amount}("");', 'if (!ok) revert EthTransferFailed(to, amount);'],
    send._sendEth,
  );

  applied.push(FINDING_IDS.SALE_FUNDS_BEFORE_FINALIZE);
}

function addClaimsAndRefunds(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  const fns = defineFunctions({
    vestedOf: {
      kind: 'public',
      args: [{ type: 'address', name: 'contributor' }],
      returns: ['uint256'],
      mutability: 'view',
    },
    claimableOf: {
      kind: 'public',
      args: [{ type: 'address', name: 'contributor' }],
      returns: ['uint256'],
      mutability: 'view',
    },
    claim: { kind: 'external', args: [], returns: ['uint256'], mutability: 'nonpayable' },
    refund: { kind: 'external', args: [], returns: ['uint256'], mutability: 'nonpayable' },
  });

  c.addConstantOrImmutableOrErrorDefinition('error NothingToClaim();');
  c.addConstantOrImmutableOrErrorDefinition('error NothingToRefund();');
  c.addConstantOrImmutableOrErrorDefinition('event Claimed(address indexed contributor, uint256 amount);');
  c.addConstantOrImmutableOrErrorDefinition('event Refunded(address indexed contributor, uint256 amount);');

  c.setFunctionComments(
    [
      '/// @notice Tokens unlocked for `contributor` so far.',
      '/// @dev LPAD-SALE-037 — nothing before the cliff, then linear over VESTING_DURATION',
      '/// @dev from the cliff; a zero duration unlocks everything at the cliff. The clock',
      '/// @dev starts at finalization, not at the sale end, so a late finalize cannot',
      '/// @dev retroactively unlock.',
    ],
    fns.vestedOf,
  );
  c.setFunctionBody(
    [
      'if (!finalized || !succeeded) return 0;',
      'uint256 allocation = allocationOf(contributor);',
      'uint256 unlockStart = uint256(finalizedAt) + VESTING_CLIFF;',
      'if (block.timestamp < unlockStart) return 0;',
      'if (VESTING_DURATION == 0) return allocation;',
      'uint256 elapsed = block.timestamp - unlockStart;',
      'if (elapsed >= VESTING_DURATION) return allocation;',
      'return (allocation * elapsed) / VESTING_DURATION;',
    ],
    fns.vestedOf,
  );

  c.setFunctionBody(['return vestedOf(contributor) - claimed[contributor];'], fns.claimableOf);

  c.setFunctionComments(
    [
      '/// @notice Claim unlocked tokens. LPAD-SALE-031 — only after a successful finalize,',
      '/// @notice and only the part not already claimed.',
    ],
    fns.claim,
  );
  c.setFunctionBody(
    [
      'if (!finalized) revert NotFinalized();',
      'if (!succeeded) revert SaleFailed();',
      'uint256 amount = claimableOf(msg.sender);',
      'if (amount == 0) revert NothingToClaim();',
      '',
      'claimed[msg.sender] += amount;',
      'emit Claimed(msg.sender, amount);',
      'TOKEN.safeTransfer(msg.sender, amount);',
      'return amount;',
    ],
    fns.claim,
  );
  c.addModifier('nonReentrant', fns.claim);

  c.setFunctionComments(
    [
      '/// @notice Take back a contribution after a failed or cancelled sale.',
      '/// @dev LPAD-SALE-032 — pull, not push: nobody\'s refund depends on anyone else\'s',
      '/// @dev address accepting ETH, and the balance is zeroed before the transfer.',
    ],
    fns.refund,
  );
  c.setFunctionBody(
    [
      'if (!finalized) revert NotFinalized();',
      'if (succeeded) revert SaleSucceeded();',
      'uint256 amount = contributed[msg.sender];',
      'if (amount == 0) revert NothingToRefund();',
      '',
      'contributed[msg.sender] = 0;',
      'emit Refunded(msg.sender, amount);',
      '_sendEth(msg.sender, amount);',
      'return amount;',
    ],
    fns.refund,
  );
  c.addModifier('nonReentrant', fns.refund);

  applied.push(FINDING_IDS.SALE_CLAIM_BEFORE_FINALIZE);
  applied.push(FINDING_IDS.SALE_PUSH_REFUNDS_REENTRANCY);
  if ((opts.vestingCliffDays ?? 0) > 0 || (opts.vestingDurationDays ?? 0) > 0) {
    applied.push(FINDING_IDS.SALE_VESTING_MATH);
  }
}

function addSaleSurface(c: ContractBuilder, opts: GenerateOptions, applied: FindingId[]): void {
  if (!opts.sweepEscapeHatch) return;

  const fns = defineFunctions({
    sweep: {
      kind: 'external',
      args: [
        { type: 'address', name: 'token' },
        { type: 'address', name: 'to' },
      ],
      mutability: 'nonpayable',
    },
  });
  c.setFunctionComments(
    [
      '/// @notice AAVE-VLT-009 — recover tokens that arrived by mistake.',
      '/// @dev The sale token is excluded; it is what contributors are owed. ETH is not',
      '/// @dev reachable: it leaves only through withdrawRaised() or refund().',
    ],
    fns.sweep,
  );
  c.setFunctionBody(
    [
      'if (token == address(TOKEN)) revert CannotSweepPrincipal(token);',
      '',
      'uint256 balance = IERC20(token).balanceOf(address(this));',
      'IERC20(token).safeTransfer(to, balance);',
      'emit Swept(token, to, balance);',
    ],
    fns.sweep,
  );
  c.addConstantOrImmutableOrErrorDefinition('error CannotSweepPrincipal(address token);');
  c.addConstantOrImmutableOrErrorDefinition(
    'event Swept(address indexed token, address indexed to, uint256 amount);',
  );
  gate(c, fns.sweep, opts, 'SWEEPER', undefined);
  applied.push(FINDING_IDS.VAULT_NO_ESCAPE_HATCH);
}
