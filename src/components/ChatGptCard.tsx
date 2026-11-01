import { Copy, ExternalLink } from 'lucide-react'
import { chatGptAddress } from '../lib/chatgpt'
import { useSettings, useToast } from '../lib/hooks'

/**
 * Everything a person needs to add voicebrain to ChatGPT: the address to paste, and the few steps. ChatGPT has no
 * "install" link for a private connector, so the one thing we can do is make the address one tap to copy.
 */
export function ChatGptCard() {
  const { settings } = useSettings()
  const toast = useToast()
  const address = chatGptAddress(settings.endpoint)

  const copy = async () => {
    try { await navigator.clipboard.writeText(address); toast('Address copied. Paste it into ChatGPT.') } catch { toast('Could not copy. Press and hold the address to select it.') }
  }

  return <div className="chatgpt">
    <p className="hint"><strong>Do this on a computer, in the ChatGPT desktop app</strong> (or chatgpt.com in a browser). Connecting from the phone app is not reliable. You need a ChatGPT plan that allows custom plugins (Plus or Pro, or a work account where your admin allows it).</p>
    <label className="field">
      <span className="field-label">Server URL to give ChatGPT</span>
      <span className="input-row">
        <input className="mono" readOnly value={address} aria-label="Address to give ChatGPT" onFocus={event => event.currentTarget.select()} />
        <button type="button" className="secondary-button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />Copy</button>
      </span>
    </label>
    <ol className="steps">
      <li>Open <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT<ExternalLink size={11} aria-hidden="true" /></a> and click <strong>Plugins</strong> in the left sidebar.</li>
      <li>Click <strong>Add</strong> (top right), then <strong>Add custom MCP server</strong>.</li>
      <li>Name it <strong>voicebrain</strong>. Under <strong>Connection</strong> choose <strong>Server URL</strong> and paste the address above. Set <strong>Authentication</strong> to <strong>OAuth</strong>.</li>
      <li>Tick <strong>I understand and want to continue</strong>, then click <strong>Create as a plugin</strong>.</li>
      <li>ChatGPT opens your voicebrain sign-in. Sign in with the same Google account you use here, and tap <strong>Approve</strong>.</li>
      <li>Start a chat and ask: “What did I record today?” If it does not reach for voicebrain, say so: “Using voicebrain, what did I record today?”</li>
    </ol>
    <p className="hint">Menu names change now and then. If you cannot find a step, the guide has pictures. Added new features later? Open the Plugins page and press the refresh button next to Add.</p>
  </div>
}
