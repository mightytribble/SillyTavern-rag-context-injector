# README

A SillyTavern extension that enables generative vector search via tool calling using a secondary model.

**WARNING**: This is a work in progress. It seems to work as expected for my Google Vertex AI use case against the current Staging branch of SillyTavern. The tweaks it needs to work (tool_choice and non-function tool calling) should end up in the next release (1.14). 

## Overview

This extension intercepts a chat completion request, selects the last N messages (or a range of messages), and then sends those along with a custom prompt and additional context to a user-defined second (cheaper?) tool-using model that is attached to a datastore. That model intelligently queries the datastore, generates a response based on what it finds, then injects that response into the original request. The original model then generates a response based on the combined context.

It's designed specifically for Google Vertex AI Search and Gemini 2.5 Flash thinking, but should work with any tool-using model.

## Yes, okay, but WHY?

The use case I'm solving for is searching chat logs and interpreting them in a way that makes sense for the main model to process. Traditional vector lookups on raw-ish chat logs doesn't work so well! I wanted to be able to lightly edit (long) chat logs, upload them to a Google Vertex AI Search datastore, and then have an inline, cheap, tool-calling model query that datastore and inject the retrieved context into the main model's request just before the last message. Being able to give the RAG model some specific context cues (like the last 10 messages along with the character description and current scenario), and then asking it to answer some specific questions (like, 'what does {{char}} know about the people in the room?') is super helpful for getting it to focus on the right stuff. And being able to dynamically inject this just before last message helps preserve cache on those big long expensive chats.

While the primary use case is making those chat logs work better, it's not limited to that! For example, you could use it with a Gamesmaster character to search through source material about the game world that would otherwise be a stupid amount of wasted context, enabling "just in time" background information or rules lookups.

## Yes, okay, but Why ~~Male Models~~ Google Vertex AI Search?

It's a happy middle between the complexity of roll-your-own DIY RAG (e.g. rolling your own Weaviate or Pinecone solution) and the Gemini file_search API. It's not too expensive (10GB free storage, 10K free requests/month), and it's easy to use and manage - just upload chatlogs to a GCP Storage Bucket or even a Google Drive folder and tell AI Search to index it. And if you need to process image-based PDFs, you can do that easily! (Yes this bit you pay for, but it's not too expensive and it works surprisingly well!). 

## Features

- Injects retrieval tools and configuration into chat completion requests, allowing the model to query RAG systems via tool calling.
- Supports multiple retrieval providers (Vertex AI Search, Google Search, Custom JSON).
- Allows for flexible configuration of retrieval settings, including maximum results and maximum tokens.
- Supports function calling and retrieval tools.
- Allows for custom system prompts and queries with familiar macros you know and love.

## Installation

### Using the SillyTavern Extension Manager 

1. Open SillyTavern
2. Go to the Extensions tab
3. Click the "Install Extension" button
4. Add `https://github.com/mightytribble/SillyTavern-rag-context-injector` to the URL field
5. Click the "Install" button
6. Restart SillyTavern

### Manual Installation
1. Download the extension from the [Releases](https://github.com/mightytribble/SillyTavern-rag-context-injector/releases) page.
2. Extract the contents of the downloaded zip file.
3. Copy the extracted folder to the `scripts/extensions/third-party` directory of your SillyTavern installation.
4. Restart SillyTavern.


## Setup

1. Get Ye A Datastore! Instructions not included but you'll need a datastore with content in it, and a model that can use a tool that connects to that datastore. 
2. ~~Profit!~~ Create a connection profile for the RAG processing model you want to use. Call it something useful like "Vertex AI Search" or "RAG Profile".
3. Create a Chat Completion Preset for your new connection profile. Turn on thinking, set a budget (I do max, YOLO), turn streaming off, adjust temp etc to taste. Save it, make sure it's associated with your new connection profile. 
4. Remember to set your connection profile and Chat Completion Preset back to your main model after you're done! Otherwise you'll be sad.
5. Configure the extension in the SillyTavern settings, including customizing your RAG Query Template.
6. Profit!

## Sample RAG Query Template

A template speaks a thousand tokens.

```
Your task is to search {{characterName}}'s memories for relevant context for this conversation:

<conversation>
{{messages:-10:-1}}
</conversation>

The scenario in which this conversation is occuring is:

<scenario>
{{scenario}}
</scenario>

You must use the available tools to query {{characterName}}'s memories. Write your reply as a series of memory statements recounting your findings, e.g. "{{characterName}} remembers X, Y and Z".

Remember, you MUST use a tool to find more information. Think step-by-step about what questions you could ask the tool to retrieve more information. Be verbose and thorough in your investigation. Consider asking:
- what does {{characterName}} know about the other people present?
- what does {{characterName}} know about their current location?
- what does {{characterName}} know about what has happened recently?

Your final reply must ONLY be a series of memory statements.  Another assistant will use this information to construct a final reply.
```

### Supported Macros

The RAG Query Template supports the following macros:
- {{lastMessage}} - last message in chat history.
- {{lastNMessages:5}} - last _N_ messages in chat history.
- {{messages:X:Y}} - A range of messages in chat history, starting at 0 and going back. {{messages:-10:-2}} will get the last 10 messages, not including the last message. {{messages:-10:-1}} will get the last 10 messages, including the last message. Good if you use a prefill or post-history message and want to *not* send that to the RAG model!
- {{recentHistory}} - last 10 messages in chat history.
- {{fullHistory}} - full chat history.
- {{char}} - the name of the AI's character (also {{characterName}} for backward compatibility).
- {{user}} - the name of the user's persona (also {{userName}} for backward compatibility).
- {{description}} - the description of the AI's character from the character card.
- {{personality}} - the personality of the AI's character from the character card.
- {{scenario}} - the scenario block from the character card.


## Sample System Prompt Template

The extension defines its own system prompt (so whatever you have set up in your chat completion preset is ignored). Here's an example:

```
You are a context retrieval assistant. You MUST use your available tools to search for and retrieve information relevant to the query. Your job is to prepare information that will be used by another assistant to create a final response.
```

## Notes

The extension supports thinking (set it in your Chat Completion preset, setting the level of effort and whether or not to return the thinking), but the amount of thinking is capped by the value you set in the Extension for `Max Tokens for RAG Response`. So set this high (e.g. 16384 or 32768) to allow your Chat Completion preset to use thinking to its fullest extent. Thinking won't appear in the UI but you can see it in the window you're running the ST binary in.

The extension supports 'forcing' tool use via the `Tool Choice: Required` option. Since this extension only configures one tool this effectively forces the model to use the retrieval tool. You should probably set this, as it's the whole point of the extension! This should work for both Gemini models and OAI-compatible tool calling.

The extension injects the RAG context into the chat with configurable placement options (see Injection Placement Configuration below). The results of the RAG query won't show up in Prompt Inspector or linger in chat history, but if you check the raw requests in the ST binary console you'll see it there. You can customize the contents of this message by editing the `Context Injection Template`. I use something like this:

```
I've conducted an initial search of the knowledge base for relevant memories. I've included anything I've found below (if it's blank, I didn't find anything relevant):
<memories>
{{ragResponse}}
</memories>
```

## Injection Placement Configuration

Control where and how RAG context is injected:

| Setting | Options | Description |
|---------|---------|-------------|
| **Injection Role** | `system`, `assistant`, `user` | Role of the injected message |
| **Injection Position** | `start`, `depth` | Where to inject |
| **Injection Depth** | 0, -1, -2, ... | Depth from end (only when Position = depth) |
| **Merge with Existing** | checkbox | Append to existing message if same role |

### Position Details
- **Start of Chat**: Inserts after system messages, before first user/assistant message
- **Depth from End**: `0` = append to end, `-1` = before last message, `-2` = before second-to-last, etc.

### Default Behavior
Assistant message, depth -1, no merge.

Remember, if you use a 'prefill' that counts as a message (the last message, position 0) in the chat for purposes of placing the injection.

Remember also if you've set your main Chat Completion Profile to 'squash system messages', the RAG context will be merged into the message at its assigned depth if it's a system or assistant role. 

I tend to use a 'framing' Chat Completion preset that puts the entire chat history before some Assistant messages that frame the context injection. My Chat Completion presets look something like this (not the actual prompt, but illustrating the structure and content):

```
System:
<system prompt stuff>
- preamble ("We're playing a game", "You're the GM", whatever)
- instructions / style guide
- Lorebook (WI - before)
- Character card & example dialogue
- Lorebook (WI -after)
</system prompt stuff>

User: Do you understand the instructions and info in the system prompt? 

Assistant: Yup, looks good. Excited to get started! What's next?

User: Cool, here's the chat history so far:
<chat_history>
{{fullHistory}}
</chat_history>

Assistant: Got it, looks cool, gtg.   <--- I set my injection depth to -1, so the RAG context is inserted here.

User: OK, your task is to reply to the last message in the chat_history. For reference, the last message was:
<last_message>
{{lastMessage}}
</last_message>
When generating your reply, remember to do X, Y and Z...(general notes about the chat, etc) and follow the instructions.
```
