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
    <p className="hint">Add voicebrain to ChatGPT once, and it can find your notes and tasks when you ask. You need a ChatGPT plan that allows custom connectors (Plus or Pro, or a work account where your admin allows it).</p>
    <label className="field">
      <span className="field-label">Address to give ChatGPT</span>
      <span className="input-row">
        <input className="mono" readOnly value={address} aria-label="Address to give ChatGPT" onFocus={event => event.currentTarget.select()} />
        <button type="button" className="secondary-button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />Copy</button>
      </span>
    </label>
    <ol className="steps">
      <li>Open <a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT<ExternalLink size={11} aria-hidden="true" /></a>, then <strong>Settings → Connectors</strong>. Under <strong>Advanced</strong>, turn on <strong>Developer mode</strong>.</li>
      <li>Choose <strong>Create</strong>. Name it <strong>voicebrain</strong>, paste the address above, and set the sign-in to <strong>OAuth</strong>.</li>
      <li>ChatGPT opens your voicebrain sign-in. Sign in with the same Google account you use here, and tap <strong>Approve</strong>.</li>
      <li>In a chat, add <strong>voicebrain</strong> from the <strong>+</strong> menu, then ask: “What did I record today?”</li>
    </ol>
    <p className="hint">Menu names change now and then. If you cannot find a step, the guide has pictures. Added new features later? Open the connector in ChatGPT and press <strong>Refresh</strong>.</p>
  </div>
}
