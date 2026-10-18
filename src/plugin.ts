import streamDeck from "@elgato/streamdeck";

import { ClaudeUsageAction } from "./actions/claude-usage-action.ts";
import { CodexUsageAction } from "./actions/codex-usage-action.ts";
import { CopilotUsageAction } from "./actions/copilot-usage-action.ts";
import { SingleWindowAction } from "./actions/single-window-action.ts";
import { registerClaudeAuthUI } from "./providers/claude/claude-auth-ui.ts";
import { registerCodexAuthUI } from "./providers/codex/codex-auth-ui.ts";

// INFO level avoids logging the full Stream Deck message traffic. This plugin handles OAuth
// tokens, so trace-level logging (which records all messages) must never be enabled.
streamDeck.logger.setLevel("info");

// Register the usage actions.
streamDeck.actions.registerAction(new ClaudeUsageAction());
streamDeck.actions.registerAction(new CodexUsageAction());
streamDeck.actions.registerAction(new CopilotUsageAction());
streamDeck.actions.registerAction(new SingleWindowAction());
registerClaudeAuthUI();
registerCodexAuthUI();

// Finally, connect to the Stream Deck.
streamDeck.connect();
