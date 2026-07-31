import { GENERATED_ERROR_RETRYABILITY } from "./generated/contract-release.js";
export declare const CONTRACT_RELEASE: {
    readonly version: "0.6.0";
    readonly protocol: {
        readonly major: 1;
        readonly minMinor: 0;
        readonly maxMinor: 0;
    };
};
export interface ProtocolVersion {
    major: number;
    minor: number;
}
export declare function isProtocolCompatible(server: ProtocolVersion): boolean;
export type HellaveErrorCode = keyof typeof GENERATED_ERROR_RETRYABILITY;
export declare const HELLAVE_ERROR_CODES: readonly ("incompatible_protocol" | "invalid_request" | "request_cancelled" | "authentication_failed" | "authorization_denied" | "resource_not_found" | "conflict" | "capacity_exceeded" | "rate_limited" | "temporarily_unavailable" | "internal")[];
export type HellaveErrorContextValue = string | number | boolean | null;
export type HellaveErrorContext = Readonly<Record<string, HellaveErrorContextValue>>;
export interface HellaveErrorEnvelope {
    code: HellaveErrorCode;
    message: string;
    retryable: boolean;
    context: HellaveErrorContext;
}
export declare function isHellaveErrorEnvelope(value: unknown): value is HellaveErrorEnvelope;
export declare class HellaveError extends Error {
    readonly code: HellaveErrorCode;
    readonly retryable: boolean;
    readonly context: HellaveErrorContext;
    constructor(code: HellaveErrorCode, message: string, context?: HellaveErrorContext);
}
//# sourceMappingURL=contracts.d.ts.map