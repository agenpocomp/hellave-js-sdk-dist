import { GENERATED_CONTRACT_RELEASE, GENERATED_ERROR_RETRYABILITY, } from "./generated/contract-release.js";
export const CONTRACT_RELEASE = GENERATED_CONTRACT_RELEASE;
export function isProtocolCompatible(server) {
    const supported = CONTRACT_RELEASE.protocol;
    return server.major === supported.major
        && server.minor >= supported.minMinor
        && server.minor <= supported.maxMinor;
}
export const HELLAVE_ERROR_CODES = Object.freeze(Object.keys(GENERATED_ERROR_RETRYABILITY));
export function isHellaveErrorEnvelope(value) {
    if (!isRecord(value) || !isHellaveErrorCode(value.code))
        return false;
    if (typeof value.message !== "string")
        return false;
    if (value.retryable !== GENERATED_ERROR_RETRYABILITY[value.code])
        return false;
    return isErrorContext(value.context);
}
export class HellaveError extends Error {
    code;
    retryable;
    context;
    constructor(code, message, context = {}) {
        super(message);
        if (!isHellaveErrorCode(code)) {
            throw new TypeError(`unknown Hellave error code: ${String(code)}`);
        }
        if (!isErrorContext(context)) {
            throw new TypeError("HellaveError context accepts at most 8 entries containing primitive values only");
        }
        this.name = "HellaveError";
        this.code = code;
        this.retryable = GENERATED_ERROR_RETRYABILITY[code];
        this.context = Object.freeze({ ...context });
    }
}
function isHellaveErrorCode(value) {
    return typeof value === "string"
        && Object.prototype.hasOwnProperty.call(GENERATED_ERROR_RETRYABILITY, value);
}
function isErrorContext(value) {
    if (!isRecord(value))
        return false;
    const entries = Object.entries(value);
    return entries.length <= 8 && entries.every(([, contextValue]) => contextValue === null
        || typeof contextValue === "string"
        || typeof contextValue === "number"
        || typeof contextValue === "boolean");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=contracts.js.map