export class DriveNotConnected extends Error {}
export interface DriveTokenProvider { accessToken(userId: string): Promise<string> }
