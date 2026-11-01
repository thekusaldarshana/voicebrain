export class DriveNotConnected extends Error {}   // thrown when the user has not connected Drive, or access was revoked
export interface DriveTokenProvider { accessToken(userId: string): Promise<string> }
