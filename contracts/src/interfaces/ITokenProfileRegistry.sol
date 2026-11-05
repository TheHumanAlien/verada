// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ITokenProfileRegistry
/// @notice Per-token profile written at launch: the ENS label under the Verada parent name, the
///         accounts allowed to edit records, ENS text records, the logo reference and an optional
///         contenthash override. The factory registers; the controller (initially the creator)
///         edits and may delegate to an editor; the takeover governor can replace the controller.
interface ITokenProfileRegistry {
    struct Profile {
        address controller;
        uint48 registeredAt;
        bool suppressed;
        address editor;
        bytes32 labelhash;
        bytes32 logoRef;
        string label;
        bytes contenthash;
    }

    struct Reservation {
        bool reserved;
        /// @dev Creator allowed to claim the reserved label; zero means nobody.
        address allowedCreator;
    }

    event TokenRegistered(
        address indexed token,
        bytes32 indexed labelhash,
        string label,
        address controller,
        bytes32 logoRef
    );
    event ControllerChanged(
        address indexed token, address indexed previousController, address indexed newController
    );
    event EditorChanged(address indexed token, address indexed editor);
    event TextChanged(address indexed token, string indexed indexedKey, string key, string value);
    event ContenthashChanged(address indexed token, bytes hash);
    event LogoChanged(address indexed token, bytes32 logoRef);
    event SuppressionChanged(address indexed token, bool suppressed);
    event GovernorChanged(address indexed governor);
    event DefaultContenthashChanged(bytes hash);
    event PlatformAddressChanged(address indexed platformAddress);
    event ParentTextChanged(string indexed indexedKey, string key, string value);
    event ReservationChanged(bytes32 indexed labelhash, bool reserved, address allowedCreator);

    /// @notice Emitted once per token when its cause focus is fixed at launch.
    event FocusSet(address indexed token, uint64 categoryMask, uint16 regionMask);

    error NotFactory();
    error FocusAlreadySet(address token);
    error ZeroFocus();
    error NotController(address token, address caller);
    error NotControllerOrEditor(address token, address caller);
    error NotGovernor();
    error NotRegistered(address token);
    error AlreadyRegistered(address token);
    error LabelTaken(bytes32 labelhash, address token);
    error LabelReserved(bytes32 labelhash);
    error EditorIsController();
    error ContenthashTooLong(uint256 length);
    error ZeroAddress();
    error ZeroParentNode();

    // ------------------------------------------------------------------ factory

    /// @notice Registers a launched token under `label`. Factory only.
    /// @return node ENS node of `<label>.<parent>`.
    function register(address token, string calldata label, address controller, bytes32 logoRef)
        external
        returns (bytes32 node);

    // ------------------------------------------------------------------ controller / governor

    /// @notice Transfers control. The controller may pass zero to renounce; the governor must pass
    ///         a non-zero account. Always clears the editor.
    function setController(address token, address newController) external;

    /// @notice Appoints (or clears, with zero) an editor who may edit records only.
    function setEditor(address token, address editor) external;

    // ------------------------------------------------------------------ controller or editor

    function setLogoRef(address token, bytes32 logoRef) external;
    function setText(address token, string calldata key, string calldata value) external;
    /// @notice Sets a per-token contenthash; empty bytes clears it (falls back to the default).
    function setContenthash(address token, bytes calldata hash) external;

    // ------------------------------------------------------------------ owner

    function setGovernor(address governor) external;
    function setDefaultContenthash(bytes calldata hash) external;
    function setPlatformAddress(address platformAddress) external;
    function setParentText(string calldata key, string calldata value) external;
    function setReservation(bytes32 labelhash, bool reserved, address allowedCreator) external;
    function setSuppressed(address token, bool suppressed) external;

    // ------------------------------------------------------------------ views

    function factory() external view returns (address);
    function governor() external view returns (address);
    function parentNode() external view returns (bytes32);
    function defaultContenthash() external view returns (bytes memory);
    function platformAddress() external view returns (address);
    function parentText(string calldata key) external view returns (string memory);
    function isRegistered(address token) external view returns (bool);

    /// @notice Fixes a registered token's cause focus: the catalogue categories and regions its
    ///         ballots draw from. Factory only, once; both masks must be non-zero (all bits set
    ///         means "any").
    function setFocus(address token, uint64 categoryMask, uint16 regionMask) external;

    /// @notice Cause focus of a token (zero masks if never set).
    function focusOf(address token) external view returns (uint64 categoryMask, uint16 regionMask);
    function getProfile(address token) external view returns (Profile memory);
    function labelOf(address token) external view returns (string memory);
    function labelhashOf(address token) external view returns (bytes32);
    function nodeOf(address token) external view returns (bytes32);
    function controllerOf(address token) external view returns (address);
    function editorOf(address token) external view returns (address);
    function logoRefOf(address token) external view returns (bytes32);
    function registeredAtOf(address token) external view returns (uint48);
    function isSuppressed(address token) external view returns (bool);
    function text(address token, string calldata key) external view returns (string memory);
    /// @notice The token's contenthash override if set, otherwise the default site contenthash.
    function contenthashOf(address token) external view returns (bytes memory);
    function tokenByLabelhash(bytes32 labelhash) external view returns (address);
    function tokenByNode(bytes32 node) external view returns (address);
    function reservationOf(bytes32 labelhash) external view returns (Reservation memory);
    function MAX_CONTENTHASH_LENGTH() external view returns (uint256);
}
