/**
 * The server a new device offers to connect to. Change it for a different deployment, or set VITE_DEFAULT_SERVER
 * when building. It is only a suggestion: nothing is stored until the device has actually been approved.
 */
export const DEFAULT_SERVER: string = (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) || 'https://vb.kusaldarshana.com'
