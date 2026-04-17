/**
 * Extension system for lifecycle events and custom tools.
 */

export type { SlashCommandInfo, SlashCommandSource } from "../slash-commands.js";
export type { SourceInfo } from "../source-info.js";
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader.js";
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner.js";
export { ExtensionRunner } from "./runner.js";
export type {
	AgentEndEvent,
	AgentStartEvent,
	// Re-exports
	AgentToolResult,
	AgentToolUpdateCallback,
	AppendEntryHandler,
	// App keybindings (for custom editors)
	AppKeybinding,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	// Context
	CompactOptions,
	CodebaseSearchToolCallEvent,
	// Events - Agent
	ContextEvent,
	// Event Results
	ContextEventResult,
	ContextUsage,
	CustomToolCallEvent,
	CustomToolResultEvent,
	DeleteFileToolCallEvent,
	EditFileToolCallEvent,
	EditNotebookToolCallEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	// API
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// Errors
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	// Runtime
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FileSearchToolCallEvent,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	GetCommandsHandler,
	GetThinkingLevelHandler,
	GrepSearchToolCallEvent,
	// Events - Input
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	ListDirToolCallEvent,
	LoadExtensionsResult,
	// Events - Message
	MessageEndEvent,
	// Message Rendering
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	OtherBuiltinToolResultEvent,
	// Provider Registration
	ProviderConfig,
	ProviderModelConfig,
	ReadFileToolCallEvent,
	ReadFileToolResultEvent,
	ReapplyToolCallEvent,
	// Commands
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	// Events - Resources
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	RunTerminalCmdToolCallEvent,
	RunTerminalCmdToolResultEvent,
	SearchReplaceToolCallEvent,
	SendMessageHandler,
	SendUserMessageHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionDirectoryEvent,
	SessionDirectoryHandler,
	SessionDirectoryResult,
	SessionEvent,
	SessionShutdownEvent,
	// Events - Session
	SessionStartEvent,
	SessionTreeEvent,
	SetActiveToolsHandler,
	SetLabelHandler,
	SetModelHandler,
	SetThinkingLevelHandler,
	TerminalInputHandler,
	// Events - Tool
	ToolCallEvent,
	ToolCallEventResult,
	// Tools
	ToolDefinition,
	// Events - Tool Execution
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	// Events - User Bash
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
} from "./types.js";
// Type guards
export { isReadFileToolResult, isRunTerminalCmdToolResult, isToolCallEventType } from "./types.js";
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.js";
