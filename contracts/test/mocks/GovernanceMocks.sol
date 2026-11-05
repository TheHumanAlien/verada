// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IBallotGovernor, IVotingScheme} from "../../src/interfaces/IVotingScheme.sol";

/// @dev Plaintext voting scheme for tests. Ballots are `abi.encode(uint8 choice)`; the per-option
///      tally is kept live in storage and becomes final through `submitTally` (which overrides it
///      with the supplied cleartexts, proof ignored) or the `finalizeFromBallots` helper. Options
///      are bounded 2..MAX_OPTIONS (32 like the Zama scheme by default; tests may lower it so a
///      ballot fills from pins alone).
contract MockVotingScheme is IVotingScheme {
    uint8 public constant MIN_OPTIONS = 2;
    uint8 public MAX_OPTIONS = 32;

    function setMaxOptions(uint8 max) external {
        MAX_OPTIONS = max;
    }

    struct Poll {
        bool opened;
        bool closed;
        bool isFinal;
        uint8 optionCount;
        uint256 ballots;
        uint64[] counts;
        mapping(address voter => bool) voted;
    }

    /// @dev Test switches for `requestTally`: revert outright, or burn all gas it is given.
    bool public failRequestTally;
    bool public burnRequestTally;
    /// @dev Test switch for `tallyOf`: revert.
    bool public failTallyOf;

    mapping(address governor => bool) private _governors;
    mapping(address governor => mapping(address token => mapping(uint256 scope => Poll))) private
        _polls;

    /// @dev Exposes the mock's ballot log so tests can assert on it.
    event MockBallot(
        address indexed governor,
        address indexed token,
        uint256 indexed scope,
        address voter,
        uint8 choice,
        uint64 weight
    );

    function setFailures(bool requestTally_, bool burnRequestTally_, bool tallyOf_) external {
        failRequestTally = requestTally_;
        burnRequestTally = burnRequestTally_;
        failTallyOf = tallyOf_;
    }

    function setGovernor(address governor, bool allowed) external {
        _governors[governor] = allowed;
        emit GovernorSet(governor, allowed);
    }

    /// @inheritdoc IVotingScheme
    function open(address token, uint256 scope, uint8 optionCount) external {
        if (!_governors[msg.sender]) revert NotGovernor(msg.sender);
        if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) {
            revert InvalidOptionCount(optionCount);
        }
        Poll storage p = _polls[msg.sender][token][scope];
        if (p.opened) revert PollAlreadyOpen(msg.sender, token, scope);
        p.opened = true;
        p.optionCount = optionCount;
        p.counts = new uint64[](optionCount);
        emit PollOpened(msg.sender, token, scope, optionCount);
    }

    /// @inheritdoc IVotingScheme
    function castBallot(address governor, address token, uint256 scope, bytes calldata ballot)
        external
        returns (bytes32 ballotRef)
    {
        ballotRef = keccak256(abi.encode(governor, token, scope, msg.sender));
        // Authorize first: the governor may open the poll lazily from inside this call.
        uint64 weight =
            IBallotGovernor(governor).authorizeBallot(token, scope, msg.sender, ballotRef);

        Poll storage p = _polls[governor][token][scope];
        if (!p.opened || p.closed) revert PollNotOpen(governor, token, scope);
        if (p.voted[msg.sender]) revert AlreadyVoted(msg.sender);
        if (weight == 0) revert ZeroWeight();
        if (ballot.length != 32) revert InvalidBallot();
        uint8 choice = abi.decode(ballot, (uint8));
        if (choice >= p.optionCount) revert InvalidBallot();

        p.voted[msg.sender] = true;
        p.ballots += 1;
        p.counts[choice] += weight;
        emit MockBallot(governor, token, scope, msg.sender, choice, weight);
        emit BallotCast(governor, token, scope, msg.sender, weight, ballotRef);
    }

    /// @inheritdoc IVotingScheme
    function requestTally(address token, uint256 scope) external {
        if (failRequestTally) revert("requestTally failed");
        if (burnRequestTally) {
            // Spin until the call runs out of gas.
            uint256 x;
            while (true) {
                unchecked {
                    ++x;
                }
            }
        }
        if (!_governors[msg.sender]) revert NotGovernor(msg.sender);
        Poll storage p = _polls[msg.sender][token][scope];
        if (!p.opened) revert PollNotOpen(msg.sender, token, scope);
        if (p.closed) revert PollClosed(msg.sender, token, scope);
        p.closed = true;
        emit TallyRequested(msg.sender, token, scope);
    }

    /// @inheritdoc IVotingScheme
    function submitTally(
        address governor,
        address token,
        uint256 scope,
        bytes calldata cleartexts,
        bytes calldata
    ) external {
        Poll storage p = _polls[governor][token][scope];
        if (!p.closed) revert PollNotClosed(governor, token, scope);
        if (p.isFinal) revert TallyAlreadyFinal(governor, token, scope);
        uint64[] memory counts = abi.decode(cleartexts, (uint64[]));
        p.counts = counts;
        p.isFinal = true;
        emit TallySubmitted(governor, token, scope, counts);
    }

    /// @dev Test helper: closes the poll if needed and publishes the live plaintext tally.
    function finalizeFromBallots(address governor, address token, uint256 scope) external {
        Poll storage p = _polls[governor][token][scope];
        if (!p.opened) revert PollNotOpen(governor, token, scope);
        if (p.isFinal) revert TallyAlreadyFinal(governor, token, scope);
        if (!p.closed) {
            p.closed = true;
            emit TallyRequested(governor, token, scope);
        }
        p.isFinal = true;
        emit TallySubmitted(governor, token, scope, p.counts);
    }

    /// @dev Test helper: live (not necessarily final) counts.
    function liveCounts(address governor, address token, uint256 scope)
        external
        view
        returns (uint64[] memory)
    {
        return _polls[governor][token][scope].counts;
    }

    /// @inheritdoc IVotingScheme
    function tallyOf(address governor, address token, uint256 scope)
        external
        view
        returns (bool isFinal, uint64[] memory counts)
    {
        if (failTallyOf) revert("tallyOf failed");
        Poll storage p = _polls[governor][token][scope];
        return (p.isFinal, p.counts);
    }

    /// @inheritdoc IVotingScheme
    function hasVoted(address governor, address token, uint256 scope, address voter)
        external
        view
        returns (bool)
    {
        return _polls[governor][token][scope].voted[voter];
    }

    /// @inheritdoc IVotingScheme
    function ballotCount(address governor, address token, uint256 scope)
        external
        view
        returns (uint256)
    {
        return _polls[governor][token][scope].ballots;
    }

    /// @inheritdoc IVotingScheme
    function isOpen(address governor, address token, uint256 scope) external view returns (bool) {
        Poll storage p = _polls[governor][token][scope];
        return p.opened && !p.closed;
    }

    /// @inheritdoc IVotingScheme
    function isClosed(address governor, address token, uint256 scope) external view returns (bool) {
        return _polls[governor][token][scope].closed;
    }

    /// @inheritdoc IVotingScheme
    function optionCountOf(address governor, address token, uint256 scope)
        external
        view
        returns (uint8)
    {
        return _polls[governor][token][scope].optionCount;
    }

    /// @inheritdoc IVotingScheme
    function isGovernor(address governor) external view returns (bool) {
        return _governors[governor];
    }
}

/// @dev Minimal stand-in for the token profile registry: only what the governors read and write.
///      Cast to `ITokenProfileRegistry` through its address.
contract MockProfileRegistryLite {
    struct Record {
        bool registered;
        address controller;
        uint48 registeredAt;
    }

    address public governor;
    uint256 public setControllerCalls;
    address public lastSetControllerToken;
    address public lastSetControllerAccount;
    address public lastSetControllerCaller;

    mapping(address token => Record) private _records;
    mapping(address token => uint64) private _categoryMask;
    mapping(address token => uint16) private _regionMask;

    error NotGovernor();
    error NotRegistered(address token);

    function setGovernor(address governor_) external {
        governor = governor_;
    }

    function register(address token, address controller) external {
        _records[token] = Record({
            registered: true,
            controller: controller,
            // Test timestamps fit comfortably in 48 bits.
            // forge-lint: disable-next-line(unsafe-typecast)
            registeredAt: uint48(block.timestamp)
        });
    }

    /// @dev Mirrors the real registry's gate when a governor is configured: the governor or the
    ///      current controller.
    function setController(address token, address newController) external {
        if (
            governor != address(0) && msg.sender != governor
                && msg.sender != _records[token].controller
        ) revert NotGovernor();
        if (!_records[token].registered) revert NotRegistered(token);
        _records[token].controller = newController;
        setControllerCalls += 1;
        lastSetControllerToken = token;
        lastSetControllerAccount = newController;
        lastSetControllerCaller = msg.sender;
    }

    function isRegistered(address token) external view returns (bool) {
        return _records[token].registered;
    }

    function controllerOf(address token) external view returns (address) {
        return _records[token].controller;
    }

    function registeredAtOf(address token) external view returns (uint48) {
        return _records[token].registeredAt;
    }

    function setFocus(address token, uint64 categoryMask, uint16 regionMask) external {
        _categoryMask[token] = categoryMask;
        _regionMask[token] = regionMask;
    }

    function focusOf(address token) external view returns (uint64, uint16) {
        return (_categoryMask[token], _regionMask[token]);
    }
}
