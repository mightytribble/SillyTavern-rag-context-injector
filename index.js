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
    maxResults: 5,
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
        if (messages[i].role === "user") {
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
    const chatMessages = messages.filter(m => m.role !== "system");
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
        const role = m.role === "user" ? "User" : "Assistant";
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
        let role = "assistant";
        if (msg.is_user) {
            role = "user";
        } else if (msg.is_system) {
            role = "system";
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

    let result = template;

    // Get context for character/user names and GLOBAL CHAT HISTORY
    const context = getContext();
    const characterName = context?.name2 || "Assistant";
    const userName = context?.name1 || "User";
    const description = context?.description || "";
    const personality = context?.personality || "";
    const scenario = context?.scenario || "";

    // Use global chat history for macros as it's more reliable than prompt messages
    // promptMessages only contains what's being sent to LLM (often truncated or system-only)
    const globalChat = context?.chat || [];
    const messages = convertSillyTavernToOpenAI(globalChat);

    // Base replacements derived from messages
    const baseVars = {
        lastMessage: getLastUserMessage(messages),
        recentHistory: getRecentHistory(messages, 10),
        fullHistory: formatMessagesForContext(messages.filter(m => m.role !== "system")),
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
        const chatMessages = messages.filter(m => m.role !== "system");

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
    const nonSystemCount = data.messages.filter(m => m.role !== "system").length;

    // If we have significantly fewer messages than global chat, something is wrong
    // (Allow some difference for context shifting/token limits, but 0 vs 8 is a bug)
    if (nonSystemCount === 0 && globalChat.length > 0) {
        console.log(DEBUG_PREFIX, "Detected missing chat history in request. Reconstructing from global context...");

        const convertedHistory = convertSillyTavernToOpenAI(globalChat);

        // Append history to existing messages (which are likely system prompts)
        // We filter out system messages from history to avoid duplication if they are already in data.messages
        const historyToAdd = convertedHistory.filter(m => m.role !== "system");

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
            if (messages[i].role !== "system") {
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
 * Main injection handler - sends RAG request and injects response
 * Triggered by CHAT_COMPLETION_SETTINGS_READY event
 * @param {object} data - The request payload being prepared
 */
async function onChatCompletionSettingsReady(data) {
    // Always log entry for debugging
    console.log(DEBUG_PREFIX, "Event triggered - CHAT_COMPLETION_SETTINGS_READY");
    const settings = getSettings();

    // [[DEBUG]] Log initial state
    debugLog("[[DEBUG]] Entry data.messages:", JSON.stringify(data.messages, null, 2));

    console.log(DEBUG_PREFIX, "Settings:", {
        enabled: settings.enabled,
        ragProfileId: settings.ragProfileId,
        useNativeRetrieval: settings.useNativeRetrieval,
        reprocessWorldInfo: settings.reprocessWorldInfo,
        debugMode: settings.debugMode
    });

    // Check if extension is enabled
    if (!settings.enabled) {
        console.log(DEBUG_PREFIX, "Extension disabled, skipping");
        return;
    }

    // Prevent infinite loops from our own RAG requests
    if (isProcessingRag) {
        console.log(DEBUG_PREFIX, "Already processing RAG, skipping to prevent loop");
        return;
    }

    // Must have a RAG profile selected
    if (!settings.ragProfileId) {
        console.log(DEBUG_PREFIX, "No RAG profile selected, skipping");
        return;
    }

    // Optional: Filter by connection profile
    if (settings.filterByProfile && settings.filterProfileId) {
        const context = getContext();
        const currentProfile = context.extensionSettings?.connectionManager?.selectedProfile;
        if (currentProfile !== settings.filterProfileId) {
            console.log(DEBUG_PREFIX, "Profile filter mismatch, skipping");
            return;
        }
    }

    // Validate tool configuration
    if (settings.useNativeRetrieval) {
        const provider = settings.retrievalProvider;
        if (provider !== "googleSearch" && !settings.datastoreId) {
            console.log(DEBUG_PREFIX, "No datastore ID configured for native retrieval, skipping");
            return;
        }
        if (provider === "custom" && !settings.customRetrievalJson) {
            console.log(DEBUG_PREFIX, "No custom retrieval JSON configured, skipping");
            return;
        }
    }

    console.log(DEBUG_PREFIX, "Starting RAG request to profile:", settings.ragProfileId);

    try {
        isProcessingRag = true;

        // Attempt to reconstruct messages if missing
        reconstructMessages(data);

        // Extract Existing World Info (for template macros)
        // World Info is NOT stored with identifier fields in data.messages.
        // Instead, we need to call getWorldInfoPrompt() directly to get the WI strings.
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
                const chatStrings = data.messages
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

        // [[ENHANCED DEBUG]] Log all message identifiers to see what's actually in the request
        debugLog("[[DEBUG]] Message identifiers in data.messages:",
            data.messages.map(m => ({
                identifier: m.identifier || 'NO_IDENTIFIER',
                role: m.role,
                contentLength: typeof m.content === 'string' ? m.content.length :
                    Array.isArray(m.content) ? m.content.length + ' items' : 'unknown'
            }))
        );
        debugLog("[[DEBUG]] World Info extracted - Before:", worldInfoBefore.substring(0, 300) + (worldInfoBefore.length > 300 ? '...' : ''), `(total: ${worldInfoBefore.length} chars)`);
        debugLog("[[DEBUG]] World Info extracted - After:", worldInfoAfter.substring(0, 300) + (worldInfoAfter.length > 300 ? '...' : ''), `(total: ${worldInfoAfter.length} chars)`);
        debugLog("[[DEBUG]] RAG User Prompt Template:", settings.ragUserPromptTemplate);

        // Build the RAG query
        // Pass extracted WI as extras to replaceTemplateVars so {{worldInfoBefore}} works
        const userPrompt = replaceTemplateVars(settings.ragUserPromptTemplate, data.messages, {
            worldInfoBefore: worldInfoBefore,
            worldInfoAfter: worldInfoAfter
        });

        // [[ENHANCED DEBUG]] Log the final query to verify macro replacement
        debugLog("[[DEBUG]] Final RAG userPrompt (first 500 chars):", userPrompt.substring(0, 500) + (userPrompt.length > 500 ? '...' : ''));
        debugLog("[[DEBUG]] Full userPrompt length:", userPrompt.length);

        // Build messages for RAG request
        // Process system prompt through replaceTemplateVars to support macros
        const systemPrompt = replaceTemplateVars(settings.ragSystemPrompt, data.messages, {
            worldInfoBefore: worldInfoBefore,
            worldInfoAfter: worldInfoAfter
        });

        const ragMessages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ];
        console.log(DEBUG_PREFIX, "RAG messages built:", ragMessages.length);
        debugLog("[[DEBUG]] Sending ragMessages:", JSON.stringify(ragMessages, null, 2));


        // Build the tool to include
        const tool = settings.useNativeRetrieval
            ? buildRetrievalTool()
            : buildFunctionTool();

        if (!tool) {
            console.log(DEBUG_PREFIX, "Failed to build tool, skipping");
            return;
        }

        console.log(DEBUG_PREFIX, "Sending RAG request with tool:", JSON.stringify(tool));

        // Send request to the RAG profile
        // Note: For Vertex AI profiles, we need to explicitly set auth_mode
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

        // [[DEBUG]] Log state after the request
        debugLog("[[DEBUG]] data.messages after RAG request (before injection):", JSON.stringify(data.messages, null, 2));
        debugLog("RAG response received:", result);

        // Extract the response content (handle different result shapes)
        // @ts-ignore - result type depends on extractData setting
        const ragResponse = (typeof result === 'object' && result !== null && 'content' in result)
            ? result.content
            : "";

        if (!ragResponse) {
            debugLog("No RAG response content, continuing without injection");
            return;
        }

        // --- WORLD INFO REPROCESSING LOGIC ---
        // If enabled, we strip old WI, re-scan the chat (which will later include RAG), and update WI strings.
        // Actually, we need to inject RAG first, THEN re-scan.

        let shouldReprocess = settings.reprocessWorldInfo;

        // Verify context availability just in case
        const context = getContext();
        if (shouldReprocess && (!context || !context.getWorldInfoPrompt || !context.getCharacterCardFields)) {
            console.warn(DEBUG_PREFIX, "Context functions missing, skipping World Info reprocessing");
            shouldReprocess = false;
        }

        // 1. Inject RAG context (we do this BEFORE reprocessing so the new content is part of the scan)
        // BUT wait, if we inject first, we need to populate '{{worldInfoBefore}}' in the injection template?
        // Usually injection template uses {{ragResponse}}. If it uses WI macros, they might be stale until reprocessed.
        // Let's assume injection template uses ragResponse mainly.

        // Format the injection using the template
        // We use the *initial* WI strings here. If the user puts {{worldInfoBefore}} in the injection template, 
        // they get the pre-RAG version. This is acceptable/expected behavior.
        const injectionContent = replaceTemplateVars(settings.injectionTemplate, data.messages, {
            ragResponse: ragResponse,
            worldInfoBefore: worldInfoBefore,
            worldInfoAfter: worldInfoAfter
        });
        debugLog("[[DEBUG]] Injection content:", injectionContent);

        // Inject RAG context
        if (Array.isArray(data.messages) && data.messages.length > 0) {
            injectRagContext(data.messages, injectionContent, settings);

            // 2. Now perform reprocessing if enabled
            if (shouldReprocess) {
                console.log(DEBUG_PREFIX, "Reprocessing World Info with new context...");

                try {
                    // Find indices of existing World Info messages
                    let wiBeforeIndex = -1;
                    let wiAfterIndex = -1;

                    for (let i = 0; i < data.messages.length; i++) {
                        if (data.messages[i].identifier === 'worldInfoBefore') wiBeforeIndex = i;
                        if (data.messages[i].identifier === 'worldInfoAfter') wiAfterIndex = i;
                    }

                    // Capture the existing roles before we modify anything (default to 'system' if not found)
                    const worldInfoBeforeRole = wiBeforeIndex !== -1 ? data.messages[wiBeforeIndex].role : 'system';
                    const worldInfoAfterRole = wiAfterIndex !== -1 ? data.messages[wiAfterIndex].role : 'system';

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
                    const chatStrings = data.messages
                        .filter(m => m.identifier !== 'worldInfoBefore' && m.identifier !== 'worldInfoAfter')
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
                    worldInfoBefore = wiResult.worldInfoBefore || "";
                    worldInfoAfter = wiResult.worldInfoAfter || "";

                    debugLog(`Regenerated World Info: Before=${worldInfoBefore.length}, After=${worldInfoAfter.length}`);

                    // Update data.messages IN-PLACE to preserve order

                    // Update or Insert 'worldInfoAfter'
                    if (wiAfterIndex !== -1) {
                        if (worldInfoAfter) {
                            data.messages[wiAfterIndex].content = worldInfoAfter;
                            data.messages[wiAfterIndex].role = worldInfoAfterRole; // Use retained role
                        } else {
                            data.messages.splice(wiAfterIndex, 1);
                            // Adjust beforeIndex if it was after the spliced element (unlikely for 'Before', but good practice)
                            if (wiBeforeIndex > wiAfterIndex) wiBeforeIndex--;
                        }
                    } else if (worldInfoAfter) {
                        data.messages.push({
                            role: worldInfoAfterRole,
                            content: worldInfoAfter,
                            identifier: 'worldInfoAfter'
                        });
                    }

                    // Update or Insert 'worldInfoBefore'
                    if (wiBeforeIndex !== -1) {
                        if (worldInfoBefore) {
                            data.messages[wiBeforeIndex].content = worldInfoBefore;
                            data.messages[wiBeforeIndex].role = worldInfoBeforeRole; // Use retained role
                        } else {
                            data.messages.splice(wiBeforeIndex, 1);
                        }
                    } else if (worldInfoBefore) {
                        data.messages.unshift({
                            role: worldInfoBeforeRole,
                            content: worldInfoBefore,
                            identifier: 'worldInfoBefore'
                        });
                    }

                } catch (e) {
                    console.error(DEBUG_PREFIX, "Error reprocessing World Info:", e);
                }
            }

            // Optionally append to system prompt
            if (settings.systemPromptAddition && Array.isArray(data.messages)) {
                const systemMessage = data.messages.find(m => m.role === "system");
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
                    data.tools = data.tools || [];
                    data.tools.push(mainTool);

                    // Set tool_choice if not "auto" (auto is typically the default)
                    if (settings.mainModelToolChoice && settings.mainModelToolChoice !== "auto") {
                        data.tool_choice = settings.mainModelToolChoice;
                    }

                    debugLog("Added retrieval tool to main model request with tool_choice:", settings.mainModelToolChoice);
                }
            }


        }
    } catch (error) {
        console.error(DEBUG_PREFIX, "RAG request failed:", error);
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

    $("#rag_enabled").prop("checked", settings.enabled);
    $("#rag_filter_by_profile").prop("checked", settings.filterByProfile);
    $("#rag_datastore_id").val(settings.datastoreId);
    $("#rag_tool_name").val(settings.toolName);
    $("#rag_tool_description").val(settings.toolDescription);
    $("#rag_use_native_retrieval").prop("checked", settings.useNativeRetrieval);
    $("#rag_retrieval_provider").val(settings.retrievalProvider);
    $("#rag_custom_retrieval_json").val(settings.customRetrievalJson);
    $("#rag_tool_choice").val(settings.toolChoice);
    $("#rag_max_results").val(settings.maxResults);
    $("#rag_max_tokens").val(settings.maxTokens);
    $("#rag_system_prompt").val(settings.ragSystemPrompt);
    $("#rag_user_prompt_template").val(settings.ragUserPromptTemplate);
    $("#rag_injection_template").val(settings.injectionTemplate);
    $("#rag_injection_role").val(settings.injectionRole);
    $("#rag_injection_position").val(settings.injectionPosition);
    $("#rag_injection_depth").val(settings.injectionDepth);
    $("#rag_injection_merge").prop("checked", settings.injectionMerge);
    $("#rag_enable_main_model_tools").prop("checked", settings.enableMainModelTools);
    $("#rag_main_model_tool_choice").val(settings.mainModelToolChoice);
    $("#rag_system_prompt_addition").val(settings.systemPromptAddition);
    $("#rag_reprocess_world_info").prop("checked", settings.reprocessWorldInfo);
    $("#rag_debug_mode").prop("checked", settings.debugMode);

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
 * Save settings from UI
 */
function saveSettings() {
    const settings = extension_settings[EXTENSION_NAME];

    settings.enabled = $("#rag_enabled").prop("checked");
    settings.filterByProfile = $("#rag_filter_by_profile").prop("checked");
    settings.datastoreId = $("#rag_datastore_id").val();
    settings.toolName = $("#rag_tool_name").val();
    settings.toolDescription = $("#rag_tool_description").val();
    settings.useNativeRetrieval = $("#rag_use_native_retrieval").prop("checked");
    settings.retrievalProvider = $("#rag_retrieval_provider").val();
    settings.customRetrievalJson = $("#rag_custom_retrieval_json").val();
    settings.toolChoice = $("#rag_tool_choice").val();
    settings.maxResults = parseInt(String($("#rag_max_results").val())) || 5;
    settings.maxTokens = parseInt(String($("#rag_max_tokens").val())) || 1000;
    settings.ragSystemPrompt = $("#rag_system_prompt").val();
    settings.ragUserPromptTemplate = $("#rag_user_prompt_template").val();
    settings.injectionTemplate = $("#rag_injection_template").val();
    settings.injectionRole = $("#rag_injection_role").val();
    settings.injectionPosition = $("#rag_injection_position").val();
    settings.injectionDepth = parseInt(String($("#rag_injection_depth").val())) || -1;
    settings.injectionMerge = $("#rag_injection_merge").prop("checked");
    settings.enableMainModelTools = $("#rag_enable_main_model_tools").prop("checked");
    settings.mainModelToolChoice = $("#rag_main_model_tool_choice").val();
    settings.systemPromptAddition = $("#rag_system_prompt_addition").val();
    settings.reprocessWorldInfo = $("#rag_reprocess_world_info").prop("checked");
    settings.debugMode = $("#rag_debug_mode").prop("checked");

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

    // Set up event listeners for settings changes
    $("#rag_enabled").on("change", saveSettings);
    $("#rag_filter_by_profile").on("change", saveSettings);
    $("#rag_datastore_id").on("input", saveSettings);
    $("#rag_tool_name").on("input", saveSettings);
    $("#rag_tool_description").on("input", saveSettings);
    $("#rag_use_native_retrieval").on("change", () => {
        updateToolTypeVisibility();
        saveSettings();
    });
    $("#rag_retrieval_provider").on("change", () => {
        updateToolTypeVisibility();
        saveSettings();
    });
    $("#rag_custom_retrieval_json").on("input", saveSettings);
    $("#rag_tool_choice").on("change", saveSettings);
    $("#rag_max_results").on("input", saveSettings);
    $("#rag_max_tokens").on("input", saveSettings);
    $("#rag_system_prompt").on("input", saveSettings);
    $("#rag_user_prompt_template").on("input", saveSettings);
    $("#rag_injection_template").on("input", saveSettings);
    $("#rag_injection_role").on("change", saveSettings);
    $("#rag_injection_position").on("change", () => {
        updateInjectionPositionVisibility();
        saveSettings();
    });
    $("#rag_injection_depth").on("input", saveSettings);
    $("#rag_injection_merge").on("change", saveSettings);
    $("#rag_enable_main_model_tools").on("change", saveSettings);
    $("#rag_main_model_tool_choice").on("change", saveSettings);
    $("#rag_system_prompt_addition").on("input", saveSettings);
    $("#rag_debug_mode").on("change", saveSettings);

    // Register the main event handler
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);

    console.log(DEBUG_PREFIX, "Extension loaded");
});
