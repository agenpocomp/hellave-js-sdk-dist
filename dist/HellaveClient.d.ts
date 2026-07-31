import { Conference } from "./Conference.js";
import type { TokenProvider, TokenProviderContext } from "./TokenProvider.js";
export interface HellaveConfig {
    /** Public HTTPS Hellave origin. Internal service URLs are never configured here. */
    controlUrl: string;
    tokenProvider: TokenProvider;
    attachTimeoutMs?: number;
    /** Total time allowed for automatic transient recovery. Defaults to two minutes. */
    recoveryBudgetMs?: number;
}
export interface AttachOptions {
    roomId: string;
    roomInstanceId: string;
    signal?: AbortSignal;
}
/** Browser entry point for stable Hellave domain operations. */
export declare class HellaveClient {
    private readonly controlClient;
    private conference_;
    private attachment;
    constructor(config: HellaveConfig);
    get conference(): Conference | null;
    attach(options: AttachOptions): Promise<Conference>;
    leave(): Promise<void>;
}
export type { TokenProvider, TokenProviderContext };
//# sourceMappingURL=HellaveClient.d.ts.map