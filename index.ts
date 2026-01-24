import type { Plugin } from "@opencode-ai/plugin"
import type { OpencodeClient, EventMessagePartUpdated, EventSessionCreated, Event, EventSessionDeleted, Session } from "@opencode-ai/sdk";
import { distance } from "fastest-levenshtein";

const MAX_REASONING_TRACE_LEN: number = 300;
const MAX_REASONING_HISTORY_SEGMENTS: number = 20;
const MIN_LEVENSHTEIN_DISTANCE: number = 30;

class SessionState {
        public reasoningHistory: string[];
        public abortMessageID?: string;
        public pendingAbort: boolean = false;
        constructor() {
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

        public getMinSimilarity() {
                const lastTrace = this.reasoningHistory.at(-1);
                if (lastTrace === undefined) {
                        return 0;
                }

                let minDistance = 1000000000;
                for (const trace of this.reasoningHistory.slice(0, this.reasoningHistory.length - 1)) {
                        const lDistance = distance(lastTrace, trace);
                        if (lDistance < minDistance) {
                                minDistance = lDistance
                        }
                }

                return minDistance;
        }

        public detectThoughtLoop(minSimilarity?: number) {
                if (this.reasoningHistory.length < MAX_REASONING_HISTORY_SEGMENTS) {
                        return false;
                }
                const lastTrace = this.reasoningHistory.at(-1);
                if (lastTrace === undefined) {
                        return false;
                }

                if (minSimilarity !== undefined) {
                        return minSimilarity < MIN_LEVENSHTEIN_DISTANCE;
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
                        this.sessions.set(event.properties.info.id, new SessionState());
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
                // Critical Section start, do not await inside here
                if (event.properties.part.type !== "reasoning") {
                        return;
                }

                const sessionID = event.properties.part.sessionID;
                let sessionState = this.sessions.get(sessionID);
                if (sessionState === undefined) {
                        sessionState = new SessionState();
                        this.sessions.set(sessionID, sessionState);
                }

                if (event.properties.part.messageID === sessionState.abortMessageID) {
                        sessionState.abortMessageID = undefined;
                        sessionState.pendingAbort = false;
                        this.debug("successfully detected system abort");
                        return;
                }

                if (sessionState.pendingAbort) {
                        this.debug("pending session abort");
                        return;
                }
                sessionState.updateDelta(event.properties.delta);
                const similarity = sessionState?.getMinSimilarity();
                this.debug(`similarity: ${similarity}`);
                if (sessionState.detectThoughtLoop(similarity)) {
                        sessionState.pendingAbort = true;
                        const abortPromise = this.client.session.abort({ path: { id: sessionID } })
                        const promptPromise = this.client.session.prompt({
                                path: { id: sessionID }, body: {
                                        messageID: event.properties.part.messageID,
                                        parts: [{ id: event.properties.part.id, synthetic: true, text: "⚠️Thought loop detected. The system has terminated this line of thinking as it is making no progress.", type: "text" }],
                                        noReply: false,
                                },
                        });
                        sessionState.reasoningHistory = [];
                        // Critical section end
                        const promptRes = await promptPromise;
                        const abortRes = await abortPromise;
                        await this.warn("Thought loop detected", { reasoningHistory: sessionState.reasoningHistory });

                        if (promptRes.error !== undefined) {
                                await this.error("failed to inject prompt", promptRes.error);
                                return;
                        }
                        sessionState.abortMessageID = promptRes.data.info.id;
                        await this.debug("successfully injected prompt");
                        if (abortRes.error !== undefined) {
                                await this.error(`failed to abort session: ${JSON.stringify(abortRes.error)}`, abortRes.error);
                                return;

                        }
                        if (abortRes.data !== true) {
                                await this.error(`failed to abort session: ${JSON.stringify(abortRes.data)}`);
                                return;
                        }
                        await this.debug("successfully aborted session");
                }
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



export const ThoughtLoopDetectorPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
        const detector = new ThoughtLoopDetector(client);
        return {
                event: async ({ event }) => {
                        await detector.handleEvent(event);
                },
        }
}
