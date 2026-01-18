import type { Plugin } from "@opencode-ai/plugin"
import type { OpencodeClient, EventMessagePartUpdated, EventSessionCreated, Event, EventSessionDeleted, Session } from "@opencode-ai/sdk";
import { distance } from "fastest-levenshtein";

const MAX_REASONING_TRACE_LEN: number = 300;
const MAX_REASONING_HISTORY_SEGMENTS: number = 10;
const MIN_LEVENSHTEIN_DISTANCE: number = 30;

class SessionState {
        public reasoningHistory: string[];
        constructor(public session: Session) {
                this.reasoningHistory = [];
        }

        public updateDelta(delta?: string) {
                if (delta === undefined) {
                        return;
                }

                const normalizedDelta = delta.toLowerCase().replace(/\s+/g, ' ').trim();
                let reasoningTrace = "";

                if (this.reasoningHistory.length !== 0) {
                        reasoningTrace = this.reasoningHistory[this.reasoningHistory.length - 1] || "";
                }

                reasoningTrace = reasoningTrace + normalizedDelta;

                if (reasoningTrace.length > MAX_REASONING_TRACE_LEN) {
                        this.reasoningHistory[this.reasoningHistory.length - 1] = reasoningTrace.slice(0, MAX_REASONING_TRACE_LEN);
                        this.reasoningHistory.push(reasoningTrace.slice(MAX_REASONING_TRACE_LEN));
                } else if (this.reasoningHistory.length > 0) {
                        this.reasoningHistory[this.reasoningHistory.length - 1] = reasoningTrace;
                } else {
                        this.reasoningHistory.push(reasoningTrace);
                }

                while (this.reasoningHistory.length > MAX_REASONING_HISTORY_SEGMENTS) {
                        this.reasoningHistory.shift();
                }
        }

        public detectThoughtLoop() {
                if (this.reasoningHistory.length < MAX_REASONING_HISTORY_SEGMENTS) {
                        return false;
                }
                const lastTrace = this.reasoningHistory.at(-1);
                if (lastTrace === undefined) {
                        return false;
                }

                for (const trace of this.reasoningHistory.slice(0, this.reasoningHistory.length - 1)) {
                        const lDistance = distance(lastTrace, trace);
                        if (lDistance < MIN_LEVENSHTEIN_DISTANCE) {
                                return true;
                        }
                }

                return false;
        }
}

class ThoughtLoopDetector {
        private sessions: Map<string, SessionState>;
        constructor(private client: OpencodeClient) {
                this.debug("Successfully loaded");
                this.sessions = new Map();
        }

        public async handleEvent(event: Event) {
                switch (event.type) {
                        case "session.created":
                                await this.handleSessionCreated(event);
                                break;
                        case "session.deleted":
                                await this.handleSessionDeleted(event);
                                break;
                        case "message.part.updated":
                                await this.handleMessagePartUpdate(event);
                                break;
                        default:
                                break;
                }
        }

        private async handleSessionCreated(event: EventSessionCreated) {
                if (!this.sessions.has(event.properties.info.id)) {
                        this.sessions.set(event.properties.info.id, new SessionState(event.properties.info));
                        this.debug(`Session state created for session ${event.properties.info.id}`);
                }
        }

        private async handleSessionDeleted(event: EventSessionDeleted) {
                if (this.sessions.has(event.properties.info.id)) {
                        this.sessions.delete(event.properties.info.id);
                        this.debug(`Session state deleted for session ${event.properties.info.id}`);
                }
        }

        private async handleMessagePartUpdate(event: EventMessagePartUpdated) {
                if (event.properties.part.type !== "reasoning") {
                        return;
                }


                if (event.properties.part.messageID === "msg_SYSTEMABORT") {
                        await this.debug("successfully detected system abort");
                        return;
                }

                const session = await this.getSessionFromMessage(event);
                if (session === undefined) {
                        return;
                }

                await this.debug(`delta: ${JSON.stringify(event.properties)}`);
                await this.debug(`delta: ${event.properties.delta}`);

                const sessionState = this.sessions.get(session.id);
                sessionState?.updateDelta(event.properties.delta);
                if (sessionState?.detectThoughtLoop()) {
                        await this.warn("Thought loop detected", { reasoningHistory: sessionState.reasoningHistory });
                        const promptRes = await this.client.session.prompt({
                                path: { id: session.id }, body: {
                                        messageID: "msg_SYSTEMABORT",
                                        parts: [{ text: "⚠️Thought loop detected. The system has terminated this line of thinking as it is making no progress.", type: "text" }],
                                        noReply: true,
                                },
                        });
                        if (promptRes.error !== undefined) {
                                await this.error("failed to inject prompt", promptRes.error);
                                return;
                        }
                        await this.debug("successfully injected prompt");
                        const abortRes = await this.client.session.abort({ path: { id: session.id } })
                        if (abortRes.error !== undefined) {
                                await this.error(`failed to abort session: ${JSON.stringify(abortRes.error)}`), abortRes.error;
                                return;

                        }
                        await this.debug("successfully aborted session");
                        sessionState.reasoningHistory = [];
                }
        }

        private async getSessionFromMessage(event: EventMessagePartUpdated) {
                const sessionRes = await this.client.session.get({ path: { id: event.properties.part.sessionID } });
                if (sessionRes.error !== undefined) {
                        await this.error(`Failed to get session ${JSON.stringify(sessionRes.error)}`);
                        return;
                }
                const session = sessionRes.data;
                await this.debug(`Got session ${session?.id}`);
                return session;
        }

        private async log(level: "debug" | "info" | "warn" | "error", message: string, extra?: { [key: string]: unknown }) {
                await this.client.app.log({
                        body: {
                                service: "[ThoughtLoopDetector]",
                                level: level,
                                message: message,
                                extra: extra
                        }
                })
        }

        private async debug(message: string, extra?: { [key: string]: unknown }) {
                await this.log("debug", message, extra);
        }

        private async info(message: string, extra?: { [key: string]: unknown }) {
                await this.log("info", message, extra);
        }

        private async warn(message: string, extra?: { [key: string]: unknown }) {
                await this.log("warn", message, extra);
        }

        private async error(message: string, extra?: { [key: string]: unknown }) {
                await this.log("error", message, extra);
        }
}



export const TestPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
        const detector = new ThoughtLoopDetector(client);
        return {
                event: async ({ event }) => {
                        await detector.handleEvent(event);
                },
        }
}
