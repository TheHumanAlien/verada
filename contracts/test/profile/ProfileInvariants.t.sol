// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {TokenProfileRegistry} from "../../src/TokenProfileRegistry.sol";
import {ITokenProfileRegistry} from "../../src/interfaces/ITokenProfileRegistry.sol";
import {LabelGen} from "../utils/LabelGen.sol";

/// @dev Drives the registry the way the factory, controllers, editors, the governor and the
///      owner would, recording ghost copies of every token's identity at registration time.
contract ProfileHandler is Test {
    TokenProfileRegistry public registry;
    address public factory;
    address public governor;
    address public owner;
    address[] public actors;

    address[] internal _tokens;
    mapping(address token => string) public labelAt;
    mapping(address token => bytes32) public labelhashAt;
    mapping(address token => uint48) public registeredAtAt;

    /// @dev Successful registrations; every one of them went through the factory.
    uint256 public registered;
    /// @dev Registrations that succeeded for a caller other than the factory (must stay zero).
    uint256 public unauthorizedRegistrations;
    uint256 public duplicateRejections;
    uint256 public reservedRejections;
    uint256 public rereferenceRejections;
    uint256 public transfers;
    uint256 public renounces;
    uint256 public takeovers;
    uint256 public editorChanges;
    uint256 public suppressions;

    uint256 internal _nonce;

    constructor(
        TokenProfileRegistry registry_,
        address factory_,
        address governor_,
        address owner_,
        address[] memory actors_
    ) {
        registry = registry_;
        factory = factory_;
        governor = governor_;
        owner = owner_;
        actors = actors_;
    }

    function getTokens() external view returns (address[] memory) {
        return _tokens;
    }

    // ------------------------------------------------------------------ registration

    function registerUnique(bytes32 seed, uint8 len, uint256 actorSeed) external {
        string memory label = LabelGen.valid(seed, len);
        bytes32 labelhash = keccak256(bytes(label));
        if (registry.tokenByLabelhash(labelhash) != address(0)) return;
        ITokenProfileRegistry.Reservation memory r = registry.reservationOf(labelhash);
        address controller = _actor(actorSeed);
        address token = _newToken();
        vm.prank(factory);
        if (r.reserved && r.allowedCreator != controller) {
            vm.expectRevert(
                abi.encodeWithSelector(ITokenProfileRegistry.LabelReserved.selector, labelhash)
            );
            registry.register(token, label, controller, seed);
            reservedRejections++;
            return;
        }
        registry.register(token, label, controller, seed);
        _record(token, label);
    }

    function registerDuplicateLabel(uint256 tokenSeed, uint256 actorSeed) external {
        address existing = _pick(tokenSeed);
        if (existing == address(0)) return;
        string memory label = registry.labelOf(existing);
        address token = _newToken();
        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.LabelTaken.selector, keccak256(bytes(label)), existing
            )
        );
        registry.register(token, label, _actor(actorSeed), 0);
        duplicateRejections++;
    }

    function registerExistingToken(uint256 tokenSeed, bytes32 seed, uint8 len) external {
        address existing = _pick(tokenSeed);
        if (existing == address(0)) return;
        string memory label = LabelGen.valid(seed, len);
        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.AlreadyRegistered.selector, existing)
        );
        registry.register(existing, label, _actor(uint256(seed)), 0);
        rereferenceRejections++;
    }

    function reserveThenRegister(bytes32 seed, uint8 len, uint256 actorSeed, bool allowed)
        external
    {
        string memory label = LabelGen.valid(seed, len);
        bytes32 labelhash = keccak256(bytes(label));
        if (registry.tokenByLabelhash(labelhash) != address(0)) return;
        address creator = _actor(actorSeed);
        address stranger = actors[(actorSeed % actors.length + 1) % actors.length];

        vm.prank(owner);
        registry.setReservation(labelhash, true, allowed ? creator : address(0));

        // A creator other than the allowed one is always blocked.
        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.LabelReserved.selector, labelhash)
        );
        registry.register(_newToken(), label, stranger, 0);
        reservedRejections++;

        if (!allowed) return;
        address token = _newToken();
        vm.prank(factory);
        registry.register(token, label, creator, 0);
        _record(token, label);
    }

    function registerAsNonFactory(bytes32 seed, uint8 len, uint256 actorSeed) external {
        address caller = _actor(actorSeed);
        string memory label = LabelGen.valid(seed, len);
        address token = _newToken();
        vm.prank(caller);
        try registry.register(token, label, caller, 0) returns (bytes32) {
            unauthorizedRegistrations++;
        } catch {}
    }

    // ------------------------------------------------------------------ control

    function transfer(uint256 tokenSeed, uint256 actorSeed) external {
        address token = _pick(tokenSeed);
        if (token == address(0)) return;
        address controller = registry.controllerOf(token);
        if (controller == address(0)) return;
        vm.prank(controller);
        registry.setController(token, _actor(actorSeed));
        transfers++;
    }

    function renounce(uint256 tokenSeed) external {
        address token = _pick(tokenSeed);
        if (token == address(0)) return;
        address controller = registry.controllerOf(token);
        if (controller == address(0)) return;
        vm.prank(controller);
        registry.setController(token, address(0));
        renounces++;
    }

    function setEditor(uint256 tokenSeed, uint256 actorSeed, bool clear) external {
        address token = _pick(tokenSeed);
        if (token == address(0)) return;
        address controller = registry.controllerOf(token);
        if (controller == address(0)) return;
        address editor = clear ? address(0) : _actor(actorSeed);
        vm.prank(controller);
        if (editor == controller) {
            vm.expectRevert(ITokenProfileRegistry.EditorIsController.selector);
            registry.setEditor(token, editor);
            return;
        }
        registry.setEditor(token, editor);
        editorChanges++;
    }

    function governorSetController(uint256 tokenSeed, uint256 actorSeed) external {
        address token = _pick(tokenSeed);
        if (token == address(0)) return;
        vm.prank(governor);
        registry.setController(token, _actor(actorSeed));
        takeovers++;
    }

    function governorCannotOrphan(uint256 tokenSeed) external {
        address token = _pick(tokenSeed);
        if (token == address(0)) return;
        // As a token's controller the governor may renounce like anyone else.
        if (registry.controllerOf(token) == governor) return;
        vm.prank(governor);
        vm.expectRevert(ITokenProfileRegistry.ZeroAddress.selector);
        registry.setController(token, address(0));
    }

    function strangerCannotTakeOver(uint256 tokenSeed, uint256 actorSeed) external {
        address token = _pick(tokenSeed);
        if (token == address(0)) return;
        address stranger = _actor(actorSeed);
        if (stranger == registry.controllerOf(token) || stranger == governor) return;
        vm.prank(stranger);
        vm.expectRevert(ITokenProfileRegistry.NotGovernor.selector);
        registry.setController(token, stranger);
    }

    function suppress(uint256 tokenSeed, bool on) external {
        address token = _pick(tokenSeed);
        if (token == address(0)) return;
        vm.prank(owner);
        registry.setSuppressed(token, on);
        suppressions++;
    }

    // ------------------------------------------------------------------ internals

    function _record(address token, string memory label) internal {
        _tokens.push(token);
        labelAt[token] = label;
        labelhashAt[token] = keccak256(bytes(label));
        registeredAtAt[token] = registry.registeredAtOf(token);
        registered++;
    }

    function _newToken() internal returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("profile-token", ++_nonce)))));
    }

    function _pick(uint256 seed) internal view returns (address) {
        if (_tokens.length == 0) return address(0);
        return _tokens[seed % _tokens.length];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }
}

/// @dev Each handler call does string work and the checks walk every registered token, so the
///      campaign is kept short; depth 64 still registers dozens of tokens per run.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: ci.invariant.runs = 128
/// forge-config: ci.invariant.depth = 64
/// forge-config: ci.invariant.fail-on-revert = true
contract ProfileInvariantTest is Test {
    bytes32 internal constant PARENT_NODE =
        0x7d4d6e6569fdd1888104213a462800d63bbc25e3e300f7cf64c5cebeb6da0aa3;

    TokenProfileRegistry internal registry;
    ProfileHandler internal handler;

    address internal factory = makeAddr("factory");
    address internal governor = makeAddr("governor");

    function setUp() public {
        registry = new TokenProfileRegistry(address(this), factory, PARENT_NODE);
        registry.setGovernor(governor);

        address[] memory actors = new address[](4);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");
        actors[3] = governor; // the governor may also hold a profile
        handler = new ProfileHandler(registry, factory, governor, address(this), actors);

        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](13);
        sels[0] = ProfileHandler.registerUnique.selector;
        sels[1] = ProfileHandler.registerDuplicateLabel.selector;
        sels[2] = ProfileHandler.registerExistingToken.selector;
        sels[3] = ProfileHandler.reserveThenRegister.selector;
        sels[4] = ProfileHandler.registerAsNonFactory.selector;
        sels[5] = ProfileHandler.transfer.selector;
        sels[6] = ProfileHandler.renounce.selector;
        sels[7] = ProfileHandler.setEditor.selector;
        sels[8] = ProfileHandler.governorSetController.selector;
        sels[9] = ProfileHandler.governorCannotOrphan.selector;
        sels[10] = ProfileHandler.strangerCannotTakeOver.selector;
        sels[11] = ProfileHandler.suppress.selector;
        sels[12] = ProfileHandler.registerUnique.selector; // weight registrations higher
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// Every registered token is found again by its labelhash and by its node, and the node is
    /// the namehash of `<label>.<parent>`.
    function invariant_bijection() public view {
        address[] memory tokens = handler.getTokens();
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            assertTrue(registry.isRegistered(t), "registered");
            bytes32 labelhash = registry.labelhashOf(t);
            bytes32 node = registry.nodeOf(t);
            assertEq(registry.tokenByLabelhash(labelhash), t, "labelhash -> token");
            assertEq(registry.tokenByNode(node), t, "node -> token");
            assertEq(node, keccak256(abi.encodePacked(PARENT_NODE, labelhash)), "node derivation");
            assertEq(labelhash, keccak256(bytes(registry.labelOf(t))), "labelhash of label");
        }
    }

    /// The editor is never the controller, and a renounced profile has no editor.
    function invariant_editorRules() public view {
        address[] memory tokens = handler.getTokens();
        for (uint256 i; i < tokens.length; ++i) {
            address controller = registry.controllerOf(tokens[i]);
            address editor = registry.editorOf(tokens[i]);
            assertTrue(editor == address(0) || editor != controller, "editor != controller");
            if (controller == address(0)) assertEq(editor, address(0), "orphan has no editor");
        }
    }

    /// Label, labelhash and registration time never change after registration.
    function invariant_identityImmutable() public view {
        address[] memory tokens = handler.getTokens();
        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            assertEq(registry.labelOf(t), handler.labelAt(t), "label");
            assertEq(registry.labelhashOf(t), handler.labelhashAt(t), "labelhash");
            assertEq(registry.registeredAtOf(t), handler.registeredAtAt(t), "registeredAt");
            ITokenProfileRegistry.Profile memory p = registry.getProfile(t);
            assertEq(p.label, handler.labelAt(t));
            assertEq(p.labelhash, handler.labelhashAt(t));
            assertEq(p.registeredAt, handler.registeredAtAt(t));
        }
    }

    /// Registrations happen only through the factory and the set of tokens only grows.
    function invariant_registrationOnlyViaFactory() public view {
        assertEq(handler.unauthorizedRegistrations(), 0, "non-factory registration");
        assertEq(handler.getTokens().length, handler.registered(), "ghost count");
    }
}
