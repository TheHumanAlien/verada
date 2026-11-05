// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ITokenProfileRegistry} from "./interfaces/ITokenProfileRegistry.sol";
import {LabelLib} from "./libraries/LabelLib.sol";

/// @title TokenProfileRegistry
/// @notice Per-token ENS profile under the Verada parent name. The factory registers a label at
///         launch; the controller (initially the creator) edits records and may delegate editing
///         to an editor; the takeover governor can replace the controller. The owner curates
///         parent-level records, label reservations and suppression.
/// @dev Labels are validated by `LabelLib` (lowercase ASCII, so a normalized client name always
///      matches the stored label). Nodes are `keccak256(parentNode ‖ labelhash)`, the ENS
///      namehash of `<label>.<parent>`; the wildcard resolver answers for them.
contract TokenProfileRegistry is ITokenProfileRegistry, Ownable2Step {
    /// @inheritdoc ITokenProfileRegistry
    uint256 public constant MAX_CONTENTHASH_LENGTH = 256;

    /// @inheritdoc ITokenProfileRegistry
    address public immutable factory;
    /// @inheritdoc ITokenProfileRegistry
    bytes32 public immutable parentNode;

    /// @inheritdoc ITokenProfileRegistry
    address public governor;
    /// @inheritdoc ITokenProfileRegistry
    address public platformAddress;
    /// @inheritdoc ITokenProfileRegistry
    mapping(bytes32 labelhash => address token) public tokenByLabelhash;
    /// @inheritdoc ITokenProfileRegistry
    mapping(bytes32 node => address token) public tokenByNode;

    bytes internal _defaultContenthash;
    mapping(address token => Profile) internal _profiles;
    mapping(address token => mapping(string key => string value)) internal _texts;
    mapping(string key => string value) internal _parentTexts;
    mapping(bytes32 labelhash => Reservation) internal _reservations;

    struct Focus {
        uint64 categoryMask;
        uint16 regionMask;
    }

    mapping(address token => Focus) internal _focus;

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(address initialOwner, address factory_, bytes32 parentNode_) Ownable(initialOwner) {
        if (factory_ == address(0)) revert ZeroAddress();
        if (parentNode_ == bytes32(0)) revert ZeroParentNode();
        factory = factory_;
        parentNode = parentNode_;
    }

    // ------------------------------------------------------------------ factory

    /// @inheritdoc ITokenProfileRegistry
    function register(address token, string calldata label, address controller, bytes32 logoRef)
        external
        onlyFactory
        returns (bytes32 node)
    {
        Profile storage p = _profiles[token];
        if (p.labelhash != bytes32(0)) revert AlreadyRegistered(token);
        bytes32 labelhash = LabelLib.validate(label);
        address holder = tokenByLabelhash[labelhash];
        if (holder != address(0)) revert LabelTaken(labelhash, holder);
        Reservation storage r = _reservations[labelhash];
        if (r.reserved && r.allowedCreator != controller) revert LabelReserved(labelhash);
        if (token == address(0) || controller == address(0)) revert ZeroAddress();

        node = keccak256(abi.encodePacked(parentNode, labelhash));
        p.controller = controller;
        // casting is safe: block.timestamp fits in 48 bits for the next 8.9 million years
        // forge-lint: disable-next-line(unsafe-typecast)
        p.registeredAt = uint48(block.timestamp);
        p.labelhash = labelhash;
        p.logoRef = logoRef;
        p.label = label;
        tokenByLabelhash[labelhash] = token;
        tokenByNode[node] = token;

        emit TokenRegistered(token, labelhash, label, controller, logoRef);
        if (logoRef != bytes32(0)) emit LogoChanged(token, logoRef);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setFocus(address token, uint64 categoryMask, uint16 regionMask) external onlyFactory {
        _registered(token);
        if (categoryMask == 0 || regionMask == 0) revert ZeroFocus();
        Focus storage f = _focus[token];
        if (f.categoryMask != 0) revert FocusAlreadySet(token);
        f.categoryMask = categoryMask;
        f.regionMask = regionMask;
        emit FocusSet(token, categoryMask, regionMask);
    }

    // ------------------------------------------------------------------ controller / governor

    /// @inheritdoc ITokenProfileRegistry
    function setController(address token, address newController) external {
        Profile storage p = _registered(token);
        address current = p.controller;
        if (msg.sender != current || current == address(0)) {
            // Anyone but the controller must be the governor, who cannot orphan the profile.
            if (msg.sender != governor || governor == address(0)) revert NotGovernor();
            if (newController == address(0)) revert ZeroAddress();
        }
        if (p.editor != address(0)) {
            p.editor = address(0);
            emit EditorChanged(token, address(0));
        }
        p.controller = newController;
        emit ControllerChanged(token, current, newController);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setEditor(address token, address editor) external {
        Profile storage p = _registered(token);
        if (msg.sender != p.controller || p.controller == address(0)) {
            revert NotController(token, msg.sender);
        }
        if (editor == p.controller) revert EditorIsController();
        p.editor = editor;
        emit EditorChanged(token, editor);
    }

    // ------------------------------------------------------------------ controller or editor

    /// @inheritdoc ITokenProfileRegistry
    function setLogoRef(address token, bytes32 logoRef) external {
        Profile storage p = _editable(token);
        p.logoRef = logoRef;
        emit LogoChanged(token, logoRef);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setText(address token, string calldata key, string calldata value) external {
        _editable(token);
        _texts[token][key] = value;
        emit TextChanged(token, key, key, value);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setContenthash(address token, bytes calldata hash) external {
        Profile storage p = _editable(token);
        if (hash.length > MAX_CONTENTHASH_LENGTH) revert ContenthashTooLong(hash.length);
        p.contenthash = hash;
        emit ContenthashChanged(token, hash);
    }

    // ------------------------------------------------------------------ owner

    /// @inheritdoc ITokenProfileRegistry
    /// @dev Zero disables governor takeovers.
    function setGovernor(address governor_) external onlyOwner {
        governor = governor_;
        emit GovernorChanged(governor_);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setDefaultContenthash(bytes calldata hash) external onlyOwner {
        if (hash.length > MAX_CONTENTHASH_LENGTH) revert ContenthashTooLong(hash.length);
        _defaultContenthash = hash;
        emit DefaultContenthashChanged(hash);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setPlatformAddress(address platformAddress_) external onlyOwner {
        platformAddress = platformAddress_;
        emit PlatformAddressChanged(platformAddress_);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setParentText(string calldata key, string calldata value) external onlyOwner {
        _parentTexts[key] = value;
        emit ParentTextChanged(key, key, value);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setReservation(bytes32 labelhash, bool reserved, address allowedCreator)
        external
        onlyOwner
    {
        _reservations[labelhash] = Reservation({reserved: reserved, allowedCreator: allowedCreator});
        emit ReservationChanged(labelhash, reserved, allowedCreator);
    }

    /// @inheritdoc ITokenProfileRegistry
    function setSuppressed(address token, bool suppressed) external onlyOwner {
        Profile storage p = _registered(token);
        p.suppressed = suppressed;
        emit SuppressionChanged(token, suppressed);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc ITokenProfileRegistry
    function defaultContenthash() external view returns (bytes memory) {
        return _defaultContenthash;
    }

    /// @inheritdoc ITokenProfileRegistry
    function parentText(string calldata key) external view returns (string memory) {
        return _parentTexts[key];
    }

    /// @inheritdoc ITokenProfileRegistry
    function isRegistered(address token) external view returns (bool) {
        return _profiles[token].labelhash != bytes32(0);
    }

    /// @inheritdoc ITokenProfileRegistry
    function focusOf(address token) external view returns (uint64 categoryMask, uint16 regionMask) {
        Focus storage f = _focus[token];
        return (f.categoryMask, f.regionMask);
    }

    /// @inheritdoc ITokenProfileRegistry
    function getProfile(address token) external view returns (Profile memory) {
        return _profiles[token];
    }

    /// @inheritdoc ITokenProfileRegistry
    function labelOf(address token) external view returns (string memory) {
        return _profiles[token].label;
    }

    /// @inheritdoc ITokenProfileRegistry
    function labelhashOf(address token) external view returns (bytes32) {
        return _profiles[token].labelhash;
    }

    /// @inheritdoc ITokenProfileRegistry
    /// @dev Zero for an unregistered token.
    function nodeOf(address token) external view returns (bytes32) {
        bytes32 labelhash = _profiles[token].labelhash;
        if (labelhash == bytes32(0)) return bytes32(0);
        return keccak256(abi.encodePacked(parentNode, labelhash));
    }

    /// @inheritdoc ITokenProfileRegistry
    function controllerOf(address token) external view returns (address) {
        return _profiles[token].controller;
    }

    /// @inheritdoc ITokenProfileRegistry
    function editorOf(address token) external view returns (address) {
        return _profiles[token].editor;
    }

    /// @inheritdoc ITokenProfileRegistry
    function logoRefOf(address token) external view returns (bytes32) {
        return _profiles[token].logoRef;
    }

    /// @inheritdoc ITokenProfileRegistry
    function registeredAtOf(address token) external view returns (uint48) {
        return _profiles[token].registeredAt;
    }

    /// @inheritdoc ITokenProfileRegistry
    function isSuppressed(address token) external view returns (bool) {
        return _profiles[token].suppressed;
    }

    /// @inheritdoc ITokenProfileRegistry
    function text(address token, string calldata key) external view returns (string memory) {
        return _texts[token][key];
    }

    /// @inheritdoc ITokenProfileRegistry
    function contenthashOf(address token) external view returns (bytes memory) {
        bytes storage h = _profiles[token].contenthash;
        return h.length != 0 ? h : _defaultContenthash;
    }

    /// @inheritdoc ITokenProfileRegistry
    function reservationOf(bytes32 labelhash) external view returns (Reservation memory) {
        return _reservations[labelhash];
    }

    // ------------------------------------------------------------------ internals

    function _registered(address token) internal view returns (Profile storage p) {
        p = _profiles[token];
        if (p.labelhash == bytes32(0)) revert NotRegistered(token);
    }

    function _editable(address token) internal view returns (Profile storage p) {
        p = _registered(token);
        if (msg.sender != p.controller && msg.sender != p.editor) {
            revert NotControllerOrEditor(token, msg.sender);
        }
    }
}
