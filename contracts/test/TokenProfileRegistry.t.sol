// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test, Vm, console2} from "forge-std/Test.sol";

import {TokenProfileRegistry} from "../src/TokenProfileRegistry.sol";
import {ITokenProfileRegistry} from "../src/interfaces/ITokenProfileRegistry.sol";
import {ContenthashLib} from "../src/libraries/ContenthashLib.sol";
import {LabelLib} from "../src/libraries/LabelLib.sol";

contract TokenProfileRegistryTest is Test {
    // namehash("varada.eth")
    bytes32 internal constant PARENT_NODE =
        0x7d4d6e6569fdd1888104213a462800d63bbc25e3e300f7cf64c5cebeb6da0aa3;

    TokenProfileRegistry internal registry;

    address internal factory = makeAddr("factory");
    address internal governor = makeAddr("governor");
    address internal creator = makeAddr("creator");
    address internal other = makeAddr("other");
    address internal editor = makeAddr("editor");
    address internal token = makeAddr("token");
    address internal token2 = makeAddr("token2");

    bytes32 internal constant LOGO = keccak256("logo");

    function setUp() public {
        registry = new TokenProfileRegistry(address(this), factory, PARENT_NODE);
        registry.setGovernor(governor);
    }

    function _register(address t, string memory label, address controller, bytes32 logoRef)
        internal
        returns (bytes32 node)
    {
        vm.prank(factory);
        node = registry.register(t, label, controller, logoRef);
    }

    function _node(string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor() public view {
        assertEq(registry.owner(), address(this));
        assertEq(registry.factory(), factory);
        assertEq(registry.parentNode(), PARENT_NODE);
        assertEq(registry.governor(), governor);
        assertEq(registry.platformAddress(), address(0));
        assertEq(registry.defaultContenthash(), "");
        assertEq(registry.MAX_CONTENTHASH_LENGTH(), 256);
    }

    function test_constructorZeroChecks() public {
        vm.expectRevert(ITokenProfileRegistry.ZeroAddress.selector);
        new TokenProfileRegistry(address(this), address(0), PARENT_NODE);
        vm.expectRevert(ITokenProfileRegistry.ZeroParentNode.selector);
        new TokenProfileRegistry(address(this), factory, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new TokenProfileRegistry(address(0), factory, PARENT_NODE);
    }

    // ------------------------------------------------------------------ register

    function test_register() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.TokenRegistered(token, keccak256("pepe"), "pepe", creator, LOGO);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.LogoChanged(token, LOGO);

        vm.prank(factory);
        uint256 gas = gasleft();
        bytes32 node = registry.register(token, "pepe", creator, LOGO);
        console2.log("TokenProfileRegistry.register gas:", gas - gasleft());

        assertEq(node, _node("pepe"));
        assertTrue(registry.isRegistered(token));
        assertEq(registry.labelOf(token), "pepe");
        assertEq(registry.labelhashOf(token), keccak256("pepe"));
        assertEq(registry.nodeOf(token), node);
        assertEq(registry.controllerOf(token), creator);
        assertEq(registry.editorOf(token), address(0));
        assertEq(registry.logoRefOf(token), LOGO);
        assertEq(registry.registeredAtOf(token), uint48(block.timestamp));
        assertFalse(registry.isSuppressed(token));
        assertEq(registry.tokenByLabelhash(keccak256("pepe")), token);
        assertEq(registry.tokenByNode(node), token);

        ITokenProfileRegistry.Profile memory p = registry.getProfile(token);
        assertEq(p.controller, creator);
        assertEq(p.registeredAt, uint48(block.timestamp));
        assertFalse(p.suppressed);
        assertEq(p.editor, address(0));
        assertEq(p.labelhash, keccak256("pepe"));
        assertEq(p.logoRef, LOGO);
        assertEq(p.label, "pepe");
        assertEq(p.contenthash, "");
    }

    function test_register_noLogoEmitsNoLogoChanged() public {
        vm.recordLogs();
        _register(token, "pepe", creator, bytes32(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], ITokenProfileRegistry.TokenRegistered.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(token))));
        assertEq(logs[0].topics[2], keccak256("pepe"));
    }

    function test_register_recordsTimestamp() public {
        vm.warp(1_800_000_000);
        _register(token, "pepe", creator, 0);
        assertEq(registry.registeredAtOf(token), 1_800_000_000);
    }

    function test_register_onlyFactory() public {
        vm.expectRevert(ITokenProfileRegistry.NotFactory.selector);
        registry.register(token, "pepe", creator, 0);
        vm.prank(creator);
        vm.expectRevert(ITokenProfileRegistry.NotFactory.selector);
        registry.register(token, "pepe", creator, 0);
        vm.prank(governor);
        vm.expectRevert(ITokenProfileRegistry.NotFactory.selector);
        registry.register(token, "pepe", creator, 0);
        assertFalse(registry.isRegistered(token));
    }

    function test_register_labelRules() public {
        string[6] memory bad = ["ab", "Pepe", "-pepe", "pepe-", "ab--c", "pe.pe"];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(factory);
            vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, bad[i]));
            registry.register(token, bad[i], creator, 0);
        }
        bytes memory long = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            long[i] = "a";
        }
        vm.prank(factory);
        vm.expectRevert(abi.encodeWithSelector(LabelLib.InvalidLabel.selector, string(long)));
        registry.register(token, string(long), creator, 0);
        assertFalse(registry.isRegistered(token));

        // Boundary labels are accepted.
        _register(token, "abc", creator, 0);
        bytes memory max = new bytes(63);
        for (uint256 i; i < 63; ++i) {
            max[i] = "z";
        }
        _register(token2, string(max), creator, 0);
        assertEq(registry.labelOf(token2), string(max));
    }

    function test_register_labelTaken() public {
        _register(token, "pepe", creator, 0);
        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.LabelTaken.selector, keccak256("pepe"), token
            )
        );
        registry.register(token2, "pepe", other, 0);
        assertFalse(registry.isRegistered(token2));
    }

    function test_register_alreadyRegistered() public {
        _register(token, "pepe", creator, 0);
        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.AlreadyRegistered.selector, token)
        );
        registry.register(token, "other", creator, 0);
        assertEq(registry.labelOf(token), "pepe");
        assertEq(registry.tokenByLabelhash(keccak256("other")), address(0));
    }

    function test_register_zeroAddresses() public {
        vm.prank(factory);
        vm.expectRevert(ITokenProfileRegistry.ZeroAddress.selector);
        registry.register(address(0), "pepe", creator, 0);
        vm.prank(factory);
        vm.expectRevert(ITokenProfileRegistry.ZeroAddress.selector);
        registry.register(token, "pepe", address(0), 0);
        assertEq(registry.tokenByLabelhash(keccak256("pepe")), address(0));
    }

    function test_register_reservedBlocksOthers() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.ReservationChanged(keccak256("verada"), true, creator);
        registry.setReservation(keccak256("verada"), true, creator);
        ITokenProfileRegistry.Reservation memory r = registry.reservationOf(keccak256("verada"));
        assertTrue(r.reserved);
        assertEq(r.allowedCreator, creator);

        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.LabelReserved.selector, keccak256("verada")
            )
        );
        registry.register(token, "verada", other, 0);

        // The allowed creator claims it.
        bytes32 node = _register(token, "verada", creator, 0);
        assertEq(registry.tokenByNode(node), token);
        assertEq(registry.controllerOf(token), creator);
    }

    function test_register_reservedForNobody() public {
        registry.setReservation(keccak256("verada"), true, address(0));
        vm.prank(factory);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.LabelReserved.selector, keccak256("verada")
            )
        );
        registry.register(token, "verada", creator, 0);
    }

    function test_register_reservationLifted() public {
        registry.setReservation(keccak256("verada"), true, address(0));
        registry.setReservation(keccak256("verada"), false, address(0));
        _register(token, "verada", other, 0);
        assertEq(registry.controllerOf(token), other);
    }

    function test_register_reservationOfAnotherLabelIsIrrelevant() public {
        registry.setReservation(keccak256("verada"), true, address(0));
        _register(token, "pepe", other, 0);
        assertTrue(registry.isRegistered(token));
    }

    function test_nodeDerivation() public {
        bytes32 node = _register(token, "pepe", creator, 0);
        bytes32 expected = keccak256(abi.encodePacked(PARENT_NODE, keccak256("pepe")));
        assertEq(node, expected);
        assertEq(registry.nodeOf(token), expected);
        assertEq(registry.tokenByNode(expected), token);
        // namehash("pepe.varada.eth") from viem.
        assertEq(node, 0x1d5d7832f3d8c36e3cd2f591b85b37bb1cfdc47fa841737d9e1632e10689c782);
        assertEq(registry.nodeOf(other), bytes32(0), "unregistered node is zero");
    }

    // ------------------------------------------------------------------ controller

    function test_setController_transfer() public {
        _register(token, "pepe", creator, 0);
        vm.prank(creator);
        registry.setEditor(token, editor);

        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.EditorChanged(token, address(0));
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.ControllerChanged(token, creator, other);
        vm.prank(creator);
        registry.setController(token, other);

        assertEq(registry.controllerOf(token), other);
        assertEq(registry.editorOf(token), address(0), "editor cleared on transfer");

        // The old controller lost its powers.
        vm.prank(creator);
        vm.expectRevert(ITokenProfileRegistry.NotGovernor.selector);
        registry.setController(token, creator);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.NotController.selector, token, creator)
        );
        registry.setEditor(token, editor);
    }

    function test_setController_noEditorEventWhenUnset() public {
        _register(token, "pepe", creator, 0);
        vm.recordLogs();
        vm.prank(creator);
        registry.setController(token, other);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], ITokenProfileRegistry.ControllerChanged.selector);
    }

    function test_setController_renounce() public {
        _register(token, "pepe", creator, 0);
        vm.prank(creator);
        registry.setEditor(token, editor);

        vm.prank(creator);
        registry.setController(token, address(0));
        assertEq(registry.controllerOf(token), address(0));
        assertEq(registry.editorOf(token), address(0));
        assertTrue(registry.isRegistered(token), "still registered");

        // Nobody can edit any more, but the governor can appoint a new controller.
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.NotControllerOrEditor.selector, token, creator
            )
        );
        registry.setText(token, "url", "x");
        vm.prank(editor);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.NotControllerOrEditor.selector, token, editor
            )
        );
        registry.setText(token, "url", "x");
        vm.prank(governor);
        registry.setController(token, other);
        assertEq(registry.controllerOf(token), other);
    }

    function test_setController_governor() public {
        _register(token, "pepe", creator, 0);
        vm.prank(creator);
        registry.setEditor(token, editor);

        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.ControllerChanged(token, creator, other);
        vm.prank(governor);
        registry.setController(token, other);
        assertEq(registry.controllerOf(token), other);
        assertEq(registry.editorOf(token), address(0), "editor cleared on takeover");
    }

    function test_setController_governorCannotOrphan() public {
        _register(token, "pepe", creator, 0);
        vm.prank(governor);
        vm.expectRevert(ITokenProfileRegistry.ZeroAddress.selector);
        registry.setController(token, address(0));
        assertEq(registry.controllerOf(token), creator);
    }

    function test_setController_othersRejected() public {
        _register(token, "pepe", creator, 0);
        vm.prank(other);
        vm.expectRevert(ITokenProfileRegistry.NotGovernor.selector);
        registry.setController(token, other);
        // The owner has no say over controllers.
        vm.expectRevert(ITokenProfileRegistry.NotGovernor.selector);
        registry.setController(token, other);
        // Nor the editor.
        vm.prank(creator);
        registry.setEditor(token, editor);
        vm.prank(editor);
        vm.expectRevert(ITokenProfileRegistry.NotGovernor.selector);
        registry.setController(token, editor);
        // Nor the factory.
        vm.prank(factory);
        vm.expectRevert(ITokenProfileRegistry.NotGovernor.selector);
        registry.setController(token, other);
        assertEq(registry.controllerOf(token), creator);
    }

    function test_setController_governorDisabled() public {
        _register(token, "pepe", creator, 0);
        registry.setGovernor(address(0));
        vm.prank(governor);
        vm.expectRevert(ITokenProfileRegistry.NotGovernor.selector);
        registry.setController(token, other);
    }

    function test_setController_notRegistered() public {
        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(ITokenProfileRegistry.NotRegistered.selector, token));
        registry.setController(token, other);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ITokenProfileRegistry.NotRegistered.selector, token));
        registry.setController(token, other);
    }

    // ------------------------------------------------------------------ editor

    function test_setEditor() public {
        _register(token, "pepe", creator, 0);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.EditorChanged(token, editor);
        vm.prank(creator);
        registry.setEditor(token, editor);
        assertEq(registry.editorOf(token), editor);

        // Clear.
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.EditorChanged(token, address(0));
        vm.prank(creator);
        registry.setEditor(token, address(0));
        assertEq(registry.editorOf(token), address(0));
    }

    function test_setEditor_controllerOnly() public {
        _register(token, "pepe", creator, 0);
        vm.prank(creator);
        registry.setEditor(token, editor);

        // The editor cannot delegate further, nor can the governor, owner or a stranger.
        vm.prank(editor);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.NotController.selector, token, editor)
        );
        registry.setEditor(token, other);
        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.NotController.selector, token, governor)
        );
        registry.setEditor(token, other);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.NotController.selector, token, address(this)
            )
        );
        registry.setEditor(token, other);
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.NotController.selector, token, other)
        );
        registry.setEditor(token, other);
        assertEq(registry.editorOf(token), editor);
    }

    function test_setEditor_cannotBeController() public {
        _register(token, "pepe", creator, 0);
        vm.prank(creator);
        vm.expectRevert(ITokenProfileRegistry.EditorIsController.selector);
        registry.setEditor(token, creator);
    }

    function test_setEditor_notRegistered() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ITokenProfileRegistry.NotRegistered.selector, token));
        registry.setEditor(token, editor);
    }

    // ------------------------------------------------------------------ records

    function test_setText() public {
        _register(token, "pepe", creator, 0);
        assertEq(registry.text(token, "url"), "");

        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.TextChanged(token, "url", "url", "https://pepe.example");
        vm.recordLogs();
        vm.prank(creator);
        registry.setText(token, "url", "https://pepe.example");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 3);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(token))));
        assertEq(logs[0].topics[2], keccak256("url"), "indexed key is its hash");
        (string memory key, string memory value) = abi.decode(logs[0].data, (string, string));
        assertEq(key, "url");
        assertEq(value, "https://pepe.example");
        assertEq(registry.text(token, "url"), "https://pepe.example");

        // The editor can edit; the value can be cleared.
        vm.prank(creator);
        registry.setEditor(token, editor);
        vm.prank(editor);
        registry.setText(token, "url", "");
        assertEq(registry.text(token, "url"), "");
        vm.prank(editor);
        registry.setText(token, "com.twitter", "pepe");
        assertEq(registry.text(token, "com.twitter"), "pepe");
        assertEq(registry.text(token2, "com.twitter"), "", "other token unaffected");
    }

    function test_setText_controllerOrEditorOnly() public {
        _register(token, "pepe", creator, 0);
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.NotControllerOrEditor.selector, token, other
            )
        );
        registry.setText(token, "url", "x");
        vm.prank(governor);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.NotControllerOrEditor.selector, token, governor
            )
        );
        registry.setText(token, "url", "x");
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.NotControllerOrEditor.selector, token, address(this)
            )
        );
        registry.setText(token, "url", "x");
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.NotRegistered.selector, token2)
        );
        registry.setText(token2, "url", "x");
    }

    function test_setLogoRef() public {
        _register(token, "pepe", creator, LOGO);
        bytes32 next = keccak256("logo2");
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.LogoChanged(token, next);
        vm.prank(creator);
        registry.setLogoRef(token, next);
        assertEq(registry.logoRefOf(token), next);

        vm.prank(creator);
        registry.setEditor(token, editor);
        vm.prank(editor);
        registry.setLogoRef(token, bytes32(0));
        assertEq(registry.logoRefOf(token), bytes32(0));

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.NotControllerOrEditor.selector, token, other
            )
        );
        registry.setLogoRef(token, next);
    }

    function test_setContenthash_overrideAndClear() public {
        _register(token, "pepe", creator, 0);
        bytes memory site = ContenthashLib.swarm(keccak256("site"));
        registry.setDefaultContenthash(site);
        assertEq(registry.contenthashOf(token), site, "default fallback");

        bytes memory mine = ContenthashLib.swarm(keccak256("mine"));
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.ContenthashChanged(token, mine);
        vm.prank(creator);
        registry.setContenthash(token, mine);
        assertEq(registry.contenthashOf(token), mine, "override");
        assertEq(registry.getProfile(token).contenthash, mine);

        // Clearing falls back to the default again.
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.ContenthashChanged(token, "");
        vm.prank(creator);
        registry.setContenthash(token, "");
        assertEq(registry.contenthashOf(token), site);
        assertEq(registry.getProfile(token).contenthash, "");

        // The editor may set it too.
        vm.prank(creator);
        registry.setEditor(token, editor);
        vm.prank(editor);
        registry.setContenthash(token, mine);
        assertEq(registry.contenthashOf(token), mine);
    }

    function test_setContenthash_tooLong() public {
        _register(token, "pepe", creator, 0);
        bytes memory max = new bytes(256);
        vm.prank(creator);
        registry.setContenthash(token, max);
        assertEq(registry.contenthashOf(token).length, 256);

        bytes memory over = new bytes(257);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.ContenthashTooLong.selector, 257)
        );
        registry.setContenthash(token, over);
    }

    function test_setContenthash_controllerOrEditorOnly() public {
        _register(token, "pepe", creator, 0);
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenProfileRegistry.NotControllerOrEditor.selector, token, other
            )
        );
        registry.setContenthash(token, hex"01");
    }

    function test_contenthashOf_unregisteredFallsBackToDefault() public {
        bytes memory site = ContenthashLib.swarm(keccak256("site"));
        registry.setDefaultContenthash(site);
        assertEq(registry.contenthashOf(other), site);
    }

    // ------------------------------------------------------------------ owner admin

    function test_setGovernor() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.GovernorChanged(other);
        registry.setGovernor(other);
        assertEq(registry.governor(), other);
        registry.setGovernor(address(0));
        assertEq(registry.governor(), address(0));
    }

    function test_setDefaultContenthash() public {
        bytes memory site = ContenthashLib.swarm(keccak256("site"));
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.DefaultContenthashChanged(site);
        registry.setDefaultContenthash(site);
        assertEq(registry.defaultContenthash(), site);

        registry.setDefaultContenthash(new bytes(256));
        assertEq(registry.defaultContenthash().length, 256);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.ContenthashTooLong.selector, 300)
        );
        registry.setDefaultContenthash(new bytes(300));

        registry.setDefaultContenthash("");
        assertEq(registry.defaultContenthash(), "");
    }

    function test_setPlatformAddress() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.PlatformAddressChanged(other);
        registry.setPlatformAddress(other);
        assertEq(registry.platformAddress(), other);
    }

    function test_setParentText() public {
        assertEq(registry.parentText("url"), "");
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.ParentTextChanged("url", "url", "https://varada.eth.limo");
        vm.recordLogs();
        registry.setParentText("url", "https://varada.eth.limo");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[1], keccak256("url"));
        assertEq(registry.parentText("url"), "https://varada.eth.limo");
        registry.setParentText("url", "");
        assertEq(registry.parentText("url"), "");
    }

    function test_setSuppressed() public {
        _register(token, "pepe", creator, 0);
        vm.expectEmit(true, true, true, true, address(registry));
        emit ITokenProfileRegistry.SuppressionChanged(token, true);
        registry.setSuppressed(token, true);
        assertTrue(registry.isSuppressed(token));
        assertTrue(registry.getProfile(token).suppressed);
        // Suppression hides, it does not unregister: the label stays taken and editable.
        assertEq(registry.tokenByLabelhash(keccak256("pepe")), token);
        vm.prank(creator);
        registry.setText(token, "url", "x");

        registry.setSuppressed(token, false);
        assertFalse(registry.isSuppressed(token));
    }

    function test_setSuppressed_notRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(ITokenProfileRegistry.NotRegistered.selector, token));
        registry.setSuppressed(token, true);
    }

    function test_ownerOnly() public {
        _register(token, "pepe", creator, 0);
        address[4] memory callers = [creator, governor, factory, other];
        for (uint256 i; i < callers.length; ++i) {
            bytes memory err =
                abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]);
            vm.startPrank(callers[i]);
            vm.expectRevert(err);
            registry.setGovernor(other);
            vm.expectRevert(err);
            registry.setDefaultContenthash(hex"01");
            vm.expectRevert(err);
            registry.setPlatformAddress(other);
            vm.expectRevert(err);
            registry.setParentText("url", "x");
            vm.expectRevert(err);
            registry.setReservation(keccak256("x"), true, other);
            vm.expectRevert(err);
            registry.setSuppressed(token, true);
            vm.stopPrank();
        }
    }

    function test_ownershipIsTwoStep() public {
        registry.transferOwnership(other);
        assertEq(registry.owner(), address(this));
        assertEq(registry.pendingOwner(), other);
        vm.prank(other);
        registry.acceptOwnership();
        assertEq(registry.owner(), other);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.setGovernor(other);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_registerLookups(
        address t,
        bytes32 seed,
        uint8 len,
        address ctrl,
        bytes32 logo
    ) public {
        vm.assume(t != address(0) && ctrl != address(0));
        string memory label = _validLabel(seed, len);
        bytes32 node = _register(t, label, ctrl, logo);
        bytes32 labelhash = keccak256(bytes(label));
        assertEq(node, keccak256(abi.encodePacked(PARENT_NODE, labelhash)));
        assertEq(registry.tokenByLabelhash(labelhash), t);
        assertEq(registry.tokenByNode(node), t);
        assertEq(registry.nodeOf(t), node);
        assertEq(registry.labelhashOf(t), labelhash);
        assertEq(registry.labelOf(t), label);
        assertEq(registry.controllerOf(t), ctrl);
        assertEq(registry.logoRefOf(t), logo);
    }

    function _validLabel(bytes32 seed, uint8 len) internal pure returns (string memory) {
        uint256 n = bound(len, 3, 63);
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = bytes1(uint8(0x61 + uint8(keccak256(abi.encodePacked(seed, i))[0]) % 26));
        }
        return string(b);
    }

    // ------------------------------------------------------------------ cause focus

    function test_setFocus_onceByFactory() public {
        _register(token, "pepe", creator, 0);
        vm.expectRevert(ITokenProfileRegistry.NotFactory.selector);
        registry.setFocus(token, 4, 1);

        vm.startPrank(factory);
        vm.expectRevert(ITokenProfileRegistry.ZeroFocus.selector);
        registry.setFocus(token, 0, 1);
        vm.expectRevert(ITokenProfileRegistry.ZeroFocus.selector);
        registry.setFocus(token, 4, 0);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.NotRegistered.selector, address(0xdead))
        );
        registry.setFocus(address(0xdead), 4, 1);

        vm.expectEmit(true, false, false, true);
        emit ITokenProfileRegistry.FocusSet(token, 4, 1);
        registry.setFocus(token, 4, 1);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenProfileRegistry.FocusAlreadySet.selector, token)
        );
        registry.setFocus(token, 8, 2);
        vm.stopPrank();

        (uint64 cm, uint16 rm) = registry.focusOf(token);
        assertEq(cm, 4);
        assertEq(rm, 1);
    }
}
