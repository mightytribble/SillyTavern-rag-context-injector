/**
 * RAG Context Injector Extension
 * 
 * Injects retrieval tools and configuration into chat completion requests,
 * allowing the model to query RAG systems via tool calling.
 * 
 * Based on the vertex-ai-search extension pattern.
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";
import { ConnectionManagerRequestService } from "../../shared.js";

// Extension Constants
const EXTENSION_NAME = "rag-context-injector";
const EXTENSION_FOLDER = `scripts/extensions/third-party/${EXTENSION_NAME}`;
const DEBUG_PREFIX = "[RAG Injector]";

// Message Roles
const ROLES = {
    USER: "user",
    ASSISTANT: "assistant",
    SYSTEM: "system",
};

// World Info Identifiers
const WORLD_INFO = {
    BEFORE: "worldInfoBefore",
    AFTER: "worldInfoAfter",
};

// Supported retrieval providers
// Tool format must include 'type' property - backend extracts via tool[tool.type]
const RETRIEVAL_PROVIDERS = {
    vertexAiSearch: {
        name: "Vertex AI Search",
        buildTool: (settings) => ({
            type: "retrieval",
            retrieval: {
                vertexAiSearch: {
                    datastore: settings.datastoreId,
                },
            },
        }),
    },
    googleSearch: {
        name: "Google Search (Grounding)",
        buildTool: (_settings) => ({
            type: "googleSearch",
            googleSearch: {},
        }),
    },
    custom: {
        name: "Custom (JSON)",
        buildTool: (settings) => {
            try {
                const parsed = JSON.parse(settings.customRetrievalJson);
                // Ensure it has a type property
                if (!parsed.type) {
                    const firstKey = Object.keys(parsed)[0];
                    parsed.type = firstKey;
                }
                return parsed;
            } catch (e) {
                console.error(DEBUG_PREFIX, "Invalid custom retrieval JSON:", e);
                return null;
            }
        },
    },
};

// Default Settings
const DEFAULT_SETTINGS = {
    enabled: false,

    // Connection Profile for RAG requests
    ragProfileId: "",         // Profile to use for RAG model requests (required)

    // Optional: Filter - only run RAG when main request uses specific profile
    filterByProfile: false,
    filterProfileId: "",

    // RAG System Configuration
    datastoreId: "",          // Datastore/collection ID for retrieval

    // Tool Configuration  
    toolName: "search_knowledge_base",
    toolDescription: "Search the knowledge base for relevant information based on a query",

    // Retrieval Settings
    useNativeRetrieval: false,
    retrievalProvider: "vertexAiSearch",  // Which provider to use for native retrieval
    customRetrievalJson: "",              // Custom JSON for 'custom' provider

    // Function Calling Settings
    toolChoice: "auto",       // "auto", "required", "none"
    maxResults: 10,
    maxTokens: 1000,          // Max tokens for RAG response

    // RAG Query Configuration
    ragSystemPrompt: "You are a context retrieval assistant. Use the available tools to search for and retrieve relevant information based on the conversation.",
    ragUserPromptTemplate: "Find relevant context for this conversation:\n\n{{lastMessage}}",

    // Injection Configuration
    injectionTemplate: "[Retrieved Context]\n{{ragResponse}}\n[End Context]",

    // Injection Placement Configuration
    injectionRole: "assistant",      // "system", "assistant", or "user"
    injectionPosition: "depth",      // "start" or "depth"
    injectionDepth: -1,              // 0 = end, -1 = before last, etc.
    injectionMerge: false,           // Merge with existing message if same role

    // Main Model Tool Access
    enableMainModelTools: false,      // Also add retrieval tool to main model request
    mainModelToolChoice: "auto",      // Tool choice for main model: "auto", "required", "none"

    // Additional context to inject
    systemPromptAddition: "",  // Text to append to system prompt

    // World Info Settings
    reprocessWorldInfo: false, // Re-run World Info scan after RAG injection

    debugMode: false,
};

/**
 * UI element bindings configuration
 * Maps DOM element IDs to settings keys with type information
 * Types: 'checkbox' (boolean), 'text' (string), 'number' (integer), 'select' (string)
 * Special handlers are needed for elements with side effects (marked with onChangeExtra)
 */
const UI_BINDINGS = [
    { id: 'rag_enabled', key: 'enabled', type: 'checkbox' },
    { id: 'rag_filter_by_profile', key: 'filterByProfile', type: 'checkbox' },
    { id: 'rag_datastore_id', key: 'datastoreId', type: 'text' },
    { id: 'rag_tool_name', key: 'toolName', type: 'text' },
    { id: 'rag_tool_description', key: 'toolDescription', type: 'text' },
    { id: 'rag_use_native_retrieval', key: 'useNativeRetrieval', type: 'checkbox', onChangeExtra: 'updateToolTypeVisibility' },
    { id: 'rag_retrieval_provider', key: 'retrievalProvider', type: 'select', onChangeExtra: 'updateToolTypeVisibility' },
    { id: 'rag_custom_retrieval_json', key: 'customRetrievalJson', type: 'text', onChangeExtra: 'validateCustomJson' },
    { id: 'rag_tool_choice', key: 'toolChoice', type: 'select' },
    { id: 'rag_max_results', key: 'maxResults', type: 'number', default: 10 },
    { id: 'rag_max_tokens', key: 'maxTokens', type: 'number', default: 1000 },
    { id: 'rag_system_prompt', key: 'ragSystemPrompt', type: 'text' },
    { id: 'rag_user_prompt_template', key: 'ragUserPromptTemplate', type: 'text' },
    { id: 'rag_injection_template', key: 'injectionTemplate', type: 'text' },
    { id: 'rag_injection_role', key: 'injectionRole', type: 'select' },
    { id: 'rag_injection_position', key: 'injectionPosition', type: 'select', onChangeExtra: 'updateInjectionPositionVisibility' },
    { id: 'rag_injection_depth', key: 'injectionDepth', type: 'number', default: -1 },
    { id: 'rag_injection_merge', key: 'injectionMerge', type: 'checkbox' },
    { id: 'rag_enable_main_model_tools', key: 'enableMainModelTools', type: 'checkbox' },
    { id: 'rag_main_model_tool_choice', key: 'mainModelToolChoice', type: 'select' },
    { id: 'rag_system_prompt_addition', key: 'systemPromptAddition', type: 'text' },
    { id: 'rag_reprocess_world_info', key: 'reprocessWorldInfo', type: 'checkbox' },
    { id: 'rag_debug_mode', key: 'debugMode', type: 'checkbox' },
];

/**
 * Get current settings with defaults
 * @returns {typeof DEFAULT_SETTINGS}
 */
function getSettings() {
    return extension_settings[EXTENSION_NAME] ?? DEFAULT_SETTINGS;
}

/**
 * Debug log helper
 * @param  {...any} args
 */
function debugLog(...args) {
    if (getSettings().debugMode) {
        console.log(DEBUG_PREFIX, ...args);
    }
}

/**
 * Build the function tool definition
 * @returns {object}
 */
function buildFunctionTool() {
    const settings = getSettings();

    return {
        type: "function",
        function: {
            name: settings.toolName,
            description: settings.toolDescription,
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "The search query to find relevant information"
                    },
                    max_results: {
                        type: "number",
                        description: `Maximum number of results to return (default: ${settings.maxResults})`
                    }
                },
                required: ["query"]
            }
        }
    };
}

/**
 * Build a native retrieval tool using the selected provider
 * @returns {object|null}
 */
function buildRetrievalTool() {
    const settings = getSettings();
    const provider = RETRIEVAL_PROVIDERS[settings.retrievalProvider];

    if (!provider) {
        console.error(DEBUG_PREFIX, "Unknown retrieval provider:", settings.retrievalProvider);
        return null;
    }

    return provider.buildTool(settings);
}

// Track if we're currently processing a RAG request to avoid infinite loops
let isProcessingRag = false;

/**
 * Get the last user message from chat messages
 * @param {Array} messages - Chat messages array
 * @returns {string}
 */
function getLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === ROLES.USER) {
            return messages[i].content || "";
        }
    }
    return "";
}

/**
 * Get the last N messages from chat (excluding system messages)
 * @param {Array} messages - Chat messages array
 * @param {number} n - Number of messages to retrieve
 * @returns {string} - Formatted messages
 */
function getLastNMessages(messages, n) {
    const chatMessages = messages.filter(m => m.role !== ROLES.SYSTEM);
    const lastN = chatMessages.slice(-n);
    return formatMessagesForContext(lastN);
}

/**
 * Get recent chat history (last 10 messages by default)
 * @param {Array} messages - Chat messages array
 * @param {number} count - Number of messages
 * @returns {string}
 */
function getRecentHistory(messages, count = 10) {
    return getLastNMessages(messages, count);
}

/**
 * Format messages array into readable context string
 * @param {Array} messages - Messages to format
 * @returns {string}
 */
function formatMessagesForContext(messages) {
    return messages.map(m => {
        const role = m.role === ROLES.USER ? "User" : "Assistant";
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${role}: ${content}`;
    }).join("\n\n");
}

/**
 * Convert SillyTavern chat messages to OpenAI format
 * @param {Array} chatMessages - SillyTavern chat array
 * @returns {Array} - OpenAI format messages {role, content}
 */
function convertSillyTavernToOpenAI(chatMessages) {
    if (!Array.isArray(chatMessages)) return [];

    return chatMessages.map(msg => {
        let role = ROLES.ASSISTANT;
        if (msg.is_user) {
            role = ROLES.USER;
        } else if (msg.is_system) {
            role = ROLES.SYSTEM;
        }

        const converted = {
            role: role,
            content: msg.mes || ""
        };

        if (msg.name) {
            converted.name = msg.name;
        }

        if (msg.extra?.thought_signatures) {
            converted.thought_signatures = msg.extra.thought_signatures;
        }

        return converted;
    });
}

/**
 * Replace template variables in a string
 * Supports: {{lastMessage}}, {{lastNMessages:5}}, {{recentHistory}}, {{fullHistory}}, {{characterName}}, {{userName}}, {{description}}, {{personality}}, {{scenario}}
 * @param {string} template 
 * @param {Array} promptMessages - Prompt messages (unused for history macros now, kept for compatibility)
 * @param {Object} extraReplacements - Additional key-value pairs for replacement (e.g. ragResponse)
 * @returns {string}
 */
function replaceTemplateVars(template, promptMessages, extraReplacements = {}) {
    if (!template) return "";

    const context = getContext();

    // 1. Handle custom replacements first (ragResponse, worldInfo)
    let result = template;
    const customReplacements = {
        ragResponse: extraReplacements.ragResponse || "",
        worldInfoBefore: extraReplacements.worldInfoBefore || "",
        worldInfoAfter: extraReplacements.worldInfoAfter || "",
        ...extraReplacements
    };

    for (const [key, value] of Object.entries(customReplacements)) {
        if (key === 'ragResponse' || key.startsWith('worldInfo')) {
            result = result.replace(new RegExp(`{{${key}}}`, 'g'), () => value || "");
        }
    }

    // 2. Use SillyTavern's native macro substitution if available
    if (context && typeof context.substituteParams === 'function') {
        // substituteParams uses the current global state (character, chat, etc)
        // This is robust and supports {{scenario}}, {{char}}, {{user}}, etc.
        result = context.substituteParams(result);

        // 3. Handle patterns that native macros might miss or that we want to support specifically
        // (Native engine handles most things now, but we'll keep our slicers just in case if they aren't standard)
        // ... Native engine likely handles custom macros too.

        return result;
    }

    // Fallback: If substituteParams is missing (should not happen if extension API is modern)
    let characterName = context?.name2 || "Assistant";
    let userName = context?.name1 || "User";
    let description = context?.description || "";
    let personality = context?.personality || "";
    let scenario = context?.scenario || "";

    // Attempt to get data from character card fields (more reliable for detailed fields)
    if (context && typeof context.getCharacterCardFields === 'function') {
        try {
            const fields = context.getCharacterCardFields();
            if (fields) {
                if (fields.name) characterName = fields.name;
                if (fields.description) description = fields.description;
                if (fields.personality) personality = fields.personality;
                if (fields.scenario) scenario = fields.scenario;
            }
        } catch (e) {
            // Fallback to standard context properties
            console.warn(DEBUG_PREFIX, "Error fetching character card fields:", e);
        }
    }

    // Use global chat history for macros as it's more reliable than prompt messages
    // promptMessages only contains what's being sent to LLM (often truncated or system-only)
    const globalChat = context?.chat || [];
    const messages = convertSillyTavernToOpenAI(globalChat);

    // Base replacements derived from messages
    const baseVars = {
        lastMessage: getLastUserMessage(messages),
        recentHistory: getRecentHistory(messages, 10),
        fullHistory: formatMessagesForContext(messages.filter(m => m.role !== ROLES.SYSTEM)),
        characterName: characterName,
        char: characterName,
        Char: characterName, // Capitalized alias
        userName: userName,
        user: userName,
        User: userName, // Capitalized alias
        description: description,
        personality: personality,
        scenario: scenario,
    };

    // Merge with extra replacements (extras override base)
    const allVars = { ...baseVars, ...extraReplacements };

    for (const [key, value] of Object.entries(allVars)) {
        // Use a function replacer to avoid issues with special chars in value
        result = result.replace(new RegExp(`{{${key}}}`, 'g'), () => value || "");
    }

    // Handle {{lastNMessages:N}} pattern
    const lastNPattern = /{{lastNMessages:(\d+)}}/g;
    result = result.replace(lastNPattern, (match, n) => {
        return getLastNMessages(messages, parseInt(n, 10));
    });

    // Handle {{messages:start:end}} pattern (Python-style slicing)
    // Examples: {{messages:-5}} (last 5), {{messages:0:3}} (first 3), {{messages:-7:-3}} (range)
    const slicePattern = /{{messages:(-?\d+)(?::(-?\d+))?}}/g;
    result = result.replace(slicePattern, (match, start, end) => {
        let startIdx = parseInt(start, 10);
        const endIdx = end ? parseInt(end, 10) : undefined;
        const chatMessages = messages.filter(m => m.role !== ROLES.SYSTEM);

        // Graceful handling for negative indices that exceed length
        // e.g. slice(-10) on array of length 8 should be slice(0)
        if (startIdx < 0 && Math.abs(startIdx) > chatMessages.length) {
            startIdx = 0;
        }
        const sliced = chatMessages.slice(startIdx, endIdx);
        return formatMessagesForContext(sliced);
    });

    return result;
}

/**
 * Reconstruct messages if they are missing from the request data
 * This is a fallback for when SillyTavern fails to populate history (e.g. some edge cases)
 * @param {Object} data - The request data
 */
function reconstructMessages(data) {
    // If messages array is missing or empty, initialize it
    if (!Array.isArray(data.messages)) {
        data.messages = [];
    }

    // Check if we need to reconstruct:
    // 1. We have global chat history
    // 2. data.messages seems to lack history (e.g. only system prompts)
    const context = getContext();
    const globalChat = context?.chat || [];

    if (globalChat.length === 0) return;

    // Count non-system messages in data.messages
    const nonSystemCount = data.messages.filter(m => m.role !== ROLES.SYSTEM).length;

    // If we have significantly fewer messages than global chat, something is wrong
    // (Allow some difference for context shifting/token limits, but 0 vs 8 is a bug)
    if (nonSystemCount === 0 && globalChat.length > 0) {
        console.log(DEBUG_PREFIX, "Detected missing chat history in request. Reconstructing from global context...");

        const convertedHistory = convertSillyTavernToOpenAI(globalChat);

        // Append history to existing messages (which are likely system prompts)
        // We filter out system messages from history to avoid duplication if they are already in data.messages
        const historyToAdd = convertedHistory.filter(m => m.role !== ROLES.SYSTEM);

        data.messages.push(...historyToAdd);

        console.log(DEBUG_PREFIX, `Reconstructed ${historyToAdd.length} messages.`);
    }
}

/**
 * Inject RAG context into messages array based on settings
 * @param {Array} messages - The messages array to inject into
 * @param {string} content - The content to inject
 * @param {object} settings - The extension settings
 */
function injectRagContext(messages, content, settings) {
    const role = settings.injectionRole;
    const position = settings.injectionPosition;
    const depth = settings.injectionDepth;
    const merge = settings.injectionMerge;

    // Find "start of chat" = index of first non-system message
    function findStartIndex() {
        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role !== ROLES.SYSTEM) {
                return i;
            }
        }
        return messages.length; // All system or empty
    }

    // Calculate target index from depth (0 = end, -1 = before last, etc.)
    function depthToIndex(d) {
        // depth 0 means insert at end (after last message)
        // depth -1 means insert before last message
        // depth -N means insert before Nth-to-last message
        const idx = messages.length + d;
        return Math.max(0, Math.min(messages.length, idx));
    }

    // Determine target index
    let targetIndex;
    if (position === "start") {
        targetIndex = findStartIndex();
    } else {
        targetIndex = depthToIndex(depth);
    }

    // Check for merge
    if (merge && targetIndex > 0 && targetIndex <= messages.length) {
        // Look at message AT the target position (or just before if at end)
        const checkIndex = targetIndex < messages.length ? targetIndex : targetIndex - 1;
        const existingMsg = messages[checkIndex];

        if (existingMsg && existingMsg.role === role) {
            existingMsg.content += "\n\n" + content;
            debugLog(`Merged RAG context into existing ${role} message at index ${checkIndex}`);
            return;
        }
    }

    // Insert new message
    messages.splice(targetIndex, 0, {
        role: role,
        content: content,
    });
    debugLog(`Inserted RAG context as ${role} at index ${targetIndex}`);
}

/**
 * Check if RAG processing should run
 * @param {object} settings - Extension settings
 * @param {object} data - Request data
 * @returns {{ shouldRun: boolean, reason?: string }}
 */
function shouldRunRag(settings, data) {
    if (!settings.enabled) return { shouldRun: false, reason: 'Extension disabled' };
    if (isProcessingRag) return { shouldRun: false, reason: 'Already processing' };
    if (!settings.ragProfileId) return { shouldRun: false, reason: 'No RAG profile' };

    if (settings.filterByProfile && settings.filterProfileId) {
        const context = getContext();
        const currentProfile = context.extensionSettings?.connectionManager?.selectedProfile;
        if (currentProfile !== settings.filterProfileId) {
            return { shouldRun: false, reason: 'Profile filter mismatch' };
        }
    }

    if (settings.useNativeRetrieval) {
        const provider = settings.retrievalProvider;
        if (provider !== 'googleSearch' && !settings.datastoreId) {
            return { shouldRun: false, reason: 'No datastore ID' };
        }
        if (provider === 'custom' && !settings.customRetrievalJson) {
            return { shouldRun: false, reason: 'No custom retrieval JSON' };
        }
    }

    return { shouldRun: true };
}

/**
 * Extract World Info strings from context
 * @param {Array} messages - Chat messages
 * @returns {Promise<{ before: string, after: string }>}
 */
async function extractWorldInfo(messages) {
    let worldInfoBefore = "";
    let worldInfoAfter = "";

    try {
        const context = getContext();
        if (context && context.getWorldInfoPrompt && context.getCharacterCardFields) {
            // Prepare scan data
            const globalScanData = context.getCharacterCardFields();
            const scanData = {
                ...globalScanData,
                personaDescription: globalScanData.persona,
                characterDescription: globalScanData.description,
                characterPersonality: globalScanData.personality,
                characterDepthPrompt: globalScanData.charDepthPrompt,
                trigger: 'normal',
            };

            // Extract content strings for the scan
            const chatStrings = messages
                .map(m => {
                    if (typeof m.content === 'string') return m.content;
                    if (Array.isArray(m.content)) return m.content.map(c => c.text || '').join('\n');
                    return '';
                });

            // Get max context
            const maxContext = context.chatCompletionSettings?.openai_max_context || 4096;

            // Get World Info - use isDryRun=true to avoid emitting events
            const wiResult = await context.getWorldInfoPrompt(chatStrings, maxContext, true, scanData);

            worldInfoBefore = wiResult.worldInfoBefore || "";
            worldInfoAfter = wiResult.worldInfoAfter || "";

            debugLog(`Retrieved World Info: Before=${worldInfoBefore.length} chars, After=${worldInfoAfter.length} chars`);
        } else {
            console.warn(DEBUG_PREFIX, "Context or getWorldInfoPrompt not available");
        }
    } catch (error) {
        console.error(DEBUG_PREFIX, "Error retrieving World Info:", error);
    }

    return { before: worldInfoBefore, after: worldInfoAfter };
}

/**
 * Send RAG request and return response
 * @param {object} settings - Extension settings
 * @param {Array} messages - Chat messages
 * @param {object} worldInfo - World Info strings {before, after}
 * @returns {Promise<string>} - RAG response content
 */
async function sendRagRequest(settings, messages, worldInfo) {
    // Build the RAG query
    const userPrompt = replaceTemplateVars(settings.ragUserPromptTemplate, messages, {
        worldInfoBefore: worldInfo.before,
        worldInfoAfter: worldInfo.after
    });

    // Build messages for RAG request
    const systemPrompt = replaceTemplateVars(settings.ragSystemPrompt, messages, {
        worldInfoBefore: worldInfo.before,
        worldInfoAfter: worldInfo.after
    });

    const ragMessages = [
        { role: ROLES.SYSTEM, content: systemPrompt },
        { role: ROLES.USER, content: userPrompt }
    ];
    console.log(DEBUG_PREFIX, "RAG messages built:", ragMessages.length);
    debugLog("[[DEBUG]] Sending ragMessages:", JSON.stringify(ragMessages, null, 2));

    // Build the tool to include
    const tool = settings.useNativeRetrieval
        ? buildRetrievalTool()
        : buildFunctionTool();

    if (!tool) {
        console.log(DEBUG_PREFIX, "Failed to build tool, skipping");
        return "";
    }

    console.log(DEBUG_PREFIX, "Sending RAG request with tool:", JSON.stringify(tool));

    // Send request to the RAG profile
    const result = await ConnectionManagerRequestService.sendRequest(
        settings.ragProfileId,
        ragMessages,
        settings.maxTokens,
        {
            stream: false,
            extractData: true,
        },
        {
            tools: [tool],
            tool_choice: settings.toolChoice === "required" ? "required" : "auto",
            // Vertex AI auth settings - uses full mode with service account
            vertexai_auth_mode: 'full',
        }
    );

    debugLog("RAG response received:", result);

    // Extract the response content
    // @ts-ignore
    return (typeof result === 'object' && result !== null && 'content' in result)
        ? result.content
        : "";
}

/**
 * Reprocess World Info with new context
 * @param {Array} messages - Chat messages (mutated in-place)
 */
async function reprocessWorldInfo(messages) {
    console.log(DEBUG_PREFIX, "Reprocessing World Info with new context...");
    const context = getContext();

    if (!context || !context.getWorldInfoPrompt || !context.getCharacterCardFields) {
        console.warn(DEBUG_PREFIX, "Context functions missing, skipping World Info reprocessing");
        return;
    }

    try {
        // Find indices of existing World Info messages
        let wiBeforeIndex = -1;
        let wiAfterIndex = -1;

        for (let i = 0; i < messages.length; i++) {
            if (messages[i].identifier === WORLD_INFO.BEFORE) wiBeforeIndex = i;
            if (messages[i].identifier === WORLD_INFO.AFTER) wiAfterIndex = i;
        }

        // Capture the existing roles before we modify anything (default to ROLES.SYSTEM if not found)
        const worldInfoBeforeRole = wiBeforeIndex !== -1 ? messages[wiBeforeIndex].role : ROLES.SYSTEM;
        const worldInfoAfterRole = wiAfterIndex !== -1 ? messages[wiAfterIndex].role : ROLES.SYSTEM;

        // Prepare for scan
        const globalScanData = context.getCharacterCardFields();
        const scanData = {
            ...globalScanData,
            personaDescription: globalScanData.persona,
            characterDescription: globalScanData.description,
            characterPersonality: globalScanData.personality,
            characterDepthPrompt: globalScanData.charDepthPrompt,
            trigger: 'normal',
        };

        // Extract content strings for the scan
        // IMPORTANT: Exclude existing WI from the scan to prevent self-triggering loops
        const chatStrings = messages
            .filter(m => m.identifier !== WORLD_INFO.BEFORE && m.identifier !== WORLD_INFO.AFTER)
            .map(m => {
                if (typeof m.content === 'string') return m.content;
                if (Array.isArray(m.content)) return m.content.map(c => c.text || '').join('\n');
                return '';
            });

        // Get max context
        const maxContext = context.chatCompletionSettings?.openai_max_context || 4096;

        // Re-generate WI
        const wiResult = await context.getWorldInfoPrompt(chatStrings, maxContext, false, scanData);

        // Update our local strings
        const worldInfoBefore = wiResult.worldInfoBefore || "";
        const worldInfoAfter = wiResult.worldInfoAfter || "";

        debugLog(`Regenerated World Info: Before=${worldInfoBefore.length}, After=${worldInfoAfter.length}`);

        // Update messages IN-PLACE to preserve order

        // Update or Insert 'worldInfoAfter'
        if (wiAfterIndex !== -1) {
            if (worldInfoAfter) {
                messages[wiAfterIndex].content = worldInfoAfter;
                messages[wiAfterIndex].role = worldInfoAfterRole; // Use retained role
            } else {
                messages.splice(wiAfterIndex, 1);
                // Adjust beforeIndex if it was after the spliced element
                if (wiBeforeIndex > wiAfterIndex) wiBeforeIndex--;
            }
        } else if (worldInfoAfter) {
            messages.push({
                role: worldInfoAfterRole,
                content: worldInfoAfter,
                identifier: WORLD_INFO.AFTER
            });
        }

        // Update or Insert 'worldInfoBefore'
        if (wiBeforeIndex !== -1) {
            if (worldInfoBefore) {
                messages[wiBeforeIndex].content = worldInfoBefore;
                messages[wiBeforeIndex].role = worldInfoBeforeRole; // Use retained role
            } else {
                messages.splice(wiBeforeIndex, 1);
            }
        } else if (worldInfoBefore) {
            messages.unshift({
                role: worldInfoBeforeRole,
                content: worldInfoBefore,
                identifier: WORLD_INFO.BEFORE
            });
        }

    } catch (e) {
        console.error(DEBUG_PREFIX, "Error reprocessing World Info:", e);
    }
}

/**
 * Main injection handler - sends RAG request and injects response
 * Triggered by CHAT_COMPLETION_SETTINGS_READY event
 * @param {object} data - The request payload being prepared
 */
async function onChatCompletionSettingsReady(data) {
    // Always log entry for debugging
    console.log(DEBUG_PREFIX, "Event triggered - CHAT_COMPLETION_SETTINGS_READY");
    const settings = getSettings();

    // Check if we should run
    const validation = shouldRunRag(settings, data);
    if (!validation.shouldRun) {
        if (validation.reason) console.log(DEBUG_PREFIX, `${validation.reason}, skipping`);
        return;
    }

    console.log(DEBUG_PREFIX, "Starting RAG request to profile:", settings.ragProfileId);

    try {
        isProcessingRag = true;

        // Attempt to reconstruct messages if missing
        reconstructMessages(data);

        // Extract Existing World Info (for template macros)
        const worldInfo = await extractWorldInfo(data.messages);

        // [[ENHANCED DEBUG]] Log all message identifiers to see what's actually in the request
        debugLog("[[DEBUG]] Message identifiers in data.messages:",
            data.messages.map(m => ({
                identifier: m.identifier || 'NO_IDENTIFIER',
                role: m.role,
                contentLength: typeof m.content === 'string' ? m.content.length :
                    Array.isArray(m.content) ? m.content.length + ' items' : 'unknown'
            }))
        );

        // Send RAG request
        const ragResponse = await sendRagRequest(settings, data.messages, worldInfo);

        if (!ragResponse) {
            debugLog("No RAG response content, continuing without injection");
            return;
        }

        // Format the injection using the template
        const injectionContent = replaceTemplateVars(settings.injectionTemplate, data.messages, {
            ragResponse: ragResponse,
            worldInfoBefore: worldInfo.before,
            worldInfoAfter: worldInfo.after
        });
        debugLog("[[DEBUG]] Injection content:", injectionContent);

        // Inject RAG context
        if (Array.isArray(data.messages) && data.messages.length > 0) {
            injectRagContext(data.messages, injectionContent, settings);

            // Reprocess World Info if enabled
            if (settings.reprocessWorldInfo) {
                await reprocessWorldInfo(data.messages);
            }

            // Optionally append to system prompt
            if (settings.systemPromptAddition && Array.isArray(data.messages)) {
                const systemMessage = data.messages.find(m => m.role === ROLES.SYSTEM);
                if (systemMessage) {
                    systemMessage.content += "\n\n" + settings.systemPromptAddition;
                }
            }

            debugLog("RAG injection complete");
            debugLog("[[DEBUG]] data.messages after injection:", JSON.stringify(data.messages, null, 2));

            // Optionally add retrieval tool to main model request
            if (settings.enableMainModelTools) {
                const mainTool = settings.useNativeRetrieval
                    ? buildRetrievalTool()
                    : buildFunctionTool();

                if (mainTool) {
                    if (!data.tools) data.tools = [];
                    data.tools.push(mainTool);

                    if (settings.mainModelToolChoice !== "none") {
                        data.tool_choice = settings.mainModelToolChoice;
                    }
                    console.log(DEBUG_PREFIX, "Added tool to main model request");
                }
            }
        }
    } catch (error) {
        console.error(DEBUG_PREFIX, "Error in RAG injection:", error);
        if (error.cause) {
            console.error(DEBUG_PREFIX, "Caused by:", error.cause);
        }
    } finally {
        isProcessingRag = false;
    }
}


/**
 * Load extension settings into the UI
 */
function loadSettingsUI() {
    const settings = getSettings();

    // Load all bound settings using the UI_BINDINGS configuration
    UI_BINDINGS.forEach(({ id, key, type }) => {
        const $el = $(`#${id}`);
        const value = settings[key];

        if (type === 'checkbox') {
            $el.prop('checked', value);
        } else {
            $el.val(value);
        }
    });

    // Populate provider dropdown
    populateProviderDropdown();

    // Toggle visibility of native vs function settings
    updateToolTypeVisibility();

    // Toggle visibility of depth field
    updateInjectionPositionVisibility();
}

/**
 * Toggle visibility based on tool type selection
 */
function updateToolTypeVisibility() {
    const useNative = $("#rag_use_native_retrieval").prop("checked");
    const provider = $("#rag_retrieval_provider").val();

    $(".rag-function-settings").toggle(!useNative);
    $(".rag-native-settings").toggle(useNative);

    // Show/hide provider-specific fields
    $(".rag-datastore-field").toggle(useNative && provider !== "googleSearch");
    $(".rag-custom-json-field").toggle(useNative && provider === "custom");

    // Validate JSON if the field became visible
    if (useNative && provider === "custom") {
        validateCustomJson();
    }
}

/**
 * Toggle visibility of injection depth field based on position selection
 */
function updateInjectionPositionVisibility() {
    const position = $("#rag_injection_position").val();
    $(".rag-depth-field").toggle(position === "depth");
}

/**
 * Populate the provider dropdown with available options
 */
function populateProviderDropdown() {
    const dropdown = $("#rag_retrieval_provider");
    dropdown.empty();

    for (const [key, provider] of Object.entries(RETRIEVAL_PROVIDERS)) {
        dropdown.append(`<option value="${key}">${provider.name}</option>`);
    }

    dropdown.val(getSettings().retrievalProvider);
}

/**
 * Validate custom JSON input and provide feedback
 */
function validateCustomJson() {
    const jsonStr = $("#rag_custom_retrieval_json").val();
    const $msg = $("#rag_json_validation_msg");
    const $field = $("#rag_custom_retrieval_json");

    // Only validate if "Custom" provider is selected
    if ($("#rag_retrieval_provider").val() !== "custom") {
        $msg.text("").css("color", "");
        $field.css("border-color", "");
        return;
    }

    if (!jsonStr || jsonStr.trim() === "") {
        $msg.text("Empty JSON").css("color", "orange");
        $field.css("border-color", "orange");
        return;
    }

    try {
        JSON.parse(jsonStr);
        $msg.text("✓ Valid JSON").css("color", "var(--smart-theme-color, #0f0)"); // Use theme color or green
        $field.css("border-color", "var(--smart-theme-color, #0f0)");
    } catch (e) {
        $msg.text(`✗ Invalid JSON: ${e.message}`).css("color", "red");
        $field.css("border-color", "red");
    }
}

/**
 * Save settings from UI
 */
function saveSettings() {
    const settings = extension_settings[EXTENSION_NAME];

    // Save all bound settings using the UI_BINDINGS configuration
    UI_BINDINGS.forEach(({ id, key, type, default: defaultValue }) => {
        const $el = $(`#${id}`);

        if (type === 'checkbox') {
            settings[key] = $el.prop('checked');
        } else if (type === 'number') {
            settings[key] = parseInt(String($el.val()), 10) || defaultValue;
        } else {
            settings[key] = $el.val();
        }
    });

    saveSettingsDebounced();
}

/**
 * Handle RAG profile selection change
 * @param {object} profile - Selected profile
 */
function onRagProfileChange(profile) {
    const settings = extension_settings[EXTENSION_NAME];
    settings.ragProfileId = profile?.id || "";
    saveSettingsDebounced();
    debugLog("RAG profile set to:", profile?.name || "None");
}

/**
 * Handle filter profile selection change
 * @param {object} profile - Selected profile
 */
function onFilterProfileChange(profile) {
    const settings = extension_settings[EXTENSION_NAME];
    settings.filterProfileId = profile?.id || "";
    saveSettingsDebounced();
    debugLog("Filter profile set to:", profile?.name || "None");
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    // Initialize settings
    extension_settings[EXTENSION_NAME] = extension_settings[EXTENSION_NAME] || {};
    Object.assign(extension_settings[EXTENSION_NAME], {
        ...DEFAULT_SETTINGS,
        ...extension_settings[EXTENSION_NAME],
    });

    // Load settings HTML
    const settingsHtml = await $.get(`${EXTENSION_FOLDER}/settings.html`);
    $("#extensions_settings").append(settingsHtml);

    // Load settings into UI
    loadSettingsUI();

    // Set up RAG model profile dropdown (required)
    try {
        const settings = getSettings();
        ConnectionManagerRequestService.handleDropdown(
            "#rag_model_profile",
            settings.ragProfileId,
            onRagProfileChange,
            () => { },
            () => { },
            () => { }
        );
        debugLog("RAG profile dropdown initialized");
    } catch (error) {
        console.warn(DEBUG_PREFIX, "Connection Manager not available:", error.message);
        $("#rag_model_profile_section").append(
            '<small class="warning">Connection Manager extension is required.</small>'
        );
    }

    // Set up filter profile dropdown (optional)
    try {
        const settings = getSettings();
        ConnectionManagerRequestService.handleDropdown(
            "#rag_filter_profile",
            settings.filterProfileId,
            onFilterProfileChange,
            () => { },
            () => { },
            () => { }
        );
        debugLog("Filter profile dropdown initialized");
    } catch (error) {
        console.warn(DEBUG_PREFIX, "Could not initialize filter profile dropdown");
        $("#rag_profile_filter_section").hide();
    }

    // Set up event listeners for settings changes using UI_BINDINGS
    // Map of extra handler names to their functions
    const extraHandlers = {
        updateToolTypeVisibility,
        updateInjectionPositionVisibility,
        validateCustomJson,
    };

    UI_BINDINGS.forEach(({ id, type, onChangeExtra }) => {
        const $el = $(`#${id}`);
        // Use 'change' for checkboxes and selects, 'input' for text/number fields
        const eventType = (type === 'checkbox' || type === 'select') ? 'change' : 'input';

        if (onChangeExtra && extraHandlers[onChangeExtra]) {
            // Element has a side effect handler
            $el.on(eventType, () => {
                extraHandlers[onChangeExtra]();
                saveSettings();
            });
        } else {
            $el.on(eventType, saveSettings);
        }
    });

    // Register the main event handler
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);

    console.log(DEBUG_PREFIX, "Extension loaded");
});
