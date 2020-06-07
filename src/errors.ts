export enum ErrorCodes {
    SUPPORT_ERROR = 100,
    POOR_CONNECTION_ERROR,
    NO_INTERNET_ACCESS_ERROR,
    DEVICE_NOT_FOUND_ERROR,
    DEVICE_PERMISSION_ERROR,
}

export class CallError extends Error {
    public readonly code: ErrorCodes;
    constructor(message: string, code: ErrorCodes) {
        super(message);
        this.code = code;
    }
}

export class DeviceError extends CallError {
    public readonly deviceType: DeviceType;

    constructor(message: string, code: ErrorCodes, deviceType: DeviceType) {
        super(message, code);
        this.deviceType = deviceType;
    }
}
