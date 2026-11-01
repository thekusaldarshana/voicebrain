import { useState } from 'react'
import { ChatGptCard } from '../components/ChatGptCard'

/** A picture from public/guide. A picture that is not there is simply left out, so the guide never shows a broken image. */
function Shot({ file, alt, wide = false }: { file: string; alt: string; wide?: boolean }) {
  const [missing, setMissing] = useState(false)
  if (missing) return null
  const src = `${import.meta.env.BASE_URL}guide/${file}`
  const image = <img src={src} alt={alt} loading="lazy" onError={() => setMissing(true)} />
  // A wide picture is small on a phone, so it opens full size when tapped.
  return <figure className={wide ? 'shot wide' : 'shot'}>{wide ? <a href={src} target="_blank" rel="noopener noreferrer" aria-label={`Open full size: ${alt}`}>{image}</a> : image}</figure>
}

const questions = [
  'What did I record today?',
  'What do I still need to do this week?',
  'Find my notes about physics.',
  'Rename the Rutherford note to something shorter.',
  'Mark “call the bank” as done.',
]

export function GuidePage() {
  return <main className="page guide-page">
    <div className="shell narrow">
      <p className="eyebrow">Help</p>
      <h1>User guide</h1>
      <p className="lede">voicebrain keeps your voice notes. You record, it writes them down and picks out tasks and ideas, your notes are kept in your own Google Drive, and ChatGPT can answer questions about them.</p>
      <nav className="guide-contents" aria-label="Guide contents">
        <a href="#guide-signin">Sign in</a><a href="#guide-record">Record</a><a href="#guide-library">Your notes</a><a href="#guide-drive">Google Drive</a><a href="#guide-chatgpt">ChatGPT</a><a href="#guide-ask">Ask</a><a href="#guide-install">Install</a><a href="#guide-privacy">Privacy</a><a href="#guide-help">If something is wrong</a>
      </nav>

      <section className="settings-section guide-section" id="guide-signin" aria-labelledby="g1">
        <h2 id="g1">1. Sign in</h2>
        <p>You sign in once on each phone or computer, with your Google account. There is no password to remember.</p>
        <Shot file="signin.png" alt="The Record screen before signing in, with a Sign in to voicebrain button" />
        <ol className="steps">
          <li>Tap <strong>Sign in</strong> (at the top, or on the Record screen). Your voicebrain server opens in a new tab.</li>
          <li>Google asks you to choose your account and sign in. Use the account the owner added for you.</li>
          <li>voicebrain shows <strong>Connect a device</strong>, with your phone’s name and a code. Check the code is the one on your phone, then tap <strong>Approve</strong>.</li>
          <li>Go back to the app. It connects by itself a moment later, and Sign in turns into Sign out.</li>
        </ol>
        <Shot file="approve-device.png" alt="The Connect a device page: the device name, the code, who you are signed in as, and Deny and Approve buttons" />
        <p className="hint">Only people the owner added can sign in. If Google says your account is not on the list, ask them to add your address. Never approve a code you did not just see in your own app.</p>
      </section>

      <section className="settings-section guide-section" id="guide-record" aria-labelledby="g2">
        <h2 id="g2">2. Record a note</h2>
        <p>Tap the big button and talk. Tap <strong>Stop and save</strong> when you are done. That is all: the note uploads by itself, then it is transcribed and filed.</p>
        <Shot file="recording.png" alt="The Record screen while recording, with a running clock and the Stop and save button" />
        <ul>
          <li>Tap the bookmark (or press <kbd>M</kbd>) to mark an important moment. You can jump back to it later.</li>
          <li>Pause and resume as you like. Paused time is not counted.</li>
          <li>No signal? Keep recording. The note stays on your phone and uploads when the connection returns.</li>
        </ul>
        <Shot file="record.png" alt="The Record screen, ready to record" />
      </section>

      <section className="settings-section guide-section" id="guide-library" aria-labelledby="g3">
        <h2 id="g3">3. Your notes</h2>
        <p>The <strong>Library</strong> lists everything you recorded. Tap a note to play it, rename it, add tags, or open it in Google Drive.</p>
        <Shot file="library.png" alt="The Library with three notes, one of them named by ChatGPT" />
        <p>A note you do not name gets a title from the assistant or the model a few seconds after it uploads. Your own name always wins: once you type one, nobody replaces it.</p>
        <Shot file="note.png" alt="An opened note with its title, tags and an Open in Google Drive button" />
        <ul>
          <li><strong>Remove from this device</strong> only clears the copy on this phone.</li>
          <li><strong>Delete everywhere</strong> asks twice and removes the recording, the transcript and everything made from it, for good.</li>
        </ul>
      </section>

      <section className="settings-section guide-section" id="guide-drive" aria-labelledby="g4">
        <h2 id="g4">4. Google Drive</h2>
        <p>Your notes live in a folder called <strong>voicebrain</strong> in your own Google Drive, one folder per note. Only you can open it. If Settings says Drive is not connected, tap <strong>Connect Google Drive</strong> and approve it once. voicebrain can only see the folder it made, not the rest of your Drive.</p>
        <p>Your <strong>account page</strong> (Settings → Manage account) shows who you are signed in as and lets you disconnect Drive or sign out of the browser.</p>
        <Shot file="settings.png" alt="Settings with the connection card showing who is signed in" />
      </section>

      <section className="settings-section guide-section" id="guide-chatgpt" aria-labelledby="g5">
        <h2 id="g5">5. Connect ChatGPT</h2>
        <ChatGptCard />
        <Shot wide file="chatgpt-1-add.png" alt="ChatGPT's Plugins page. Numbered: 1 the Plugins icon in the sidebar, 2 the Add button, 3 Add custom MCP server" />
        <Shot wide file="chatgpt-2-form.png" alt="The Add custom MCP server form filled in: name, Server URL ending in /mcp, Authentication set to OAuth, and the understand box ticked" />
        <p>After you click <strong>Create as a plugin</strong>, ChatGPT opens voicebrain’s own page to ask for access. Check it says it is from ChatGPT, then tap <strong>Approve</strong>.</p>
        <Shot file="approve-chatgpt.png" alt="The Approve access page: ChatGPT wants to read your voice notes and wiki, mark tasks done and write wiki pages, with Deny and Approve buttons" />
      </section>

      <section className="settings-section guide-section" id="guide-ask" aria-labelledby="g6">
        <h2 id="g6">6. Ask ChatGPT</h2>
        <p>Once connected, just talk to ChatGPT about your notes. Try:</p>
        <ul>{questions.map(question => <li key={question}>“{question}”</li>)}</ul>
        <p>Asking is always allowed. When ChatGPT wants to <strong>change</strong> something (rename a note, mark a task done), it asks you first. That is ChatGPT’s own safety step and it cannot be switched off from here. Names it gives your notes show up in this app within about half a minute.</p>
      </section>

      <section className="settings-section guide-section" id="guide-install" aria-labelledby="g7">
        <h2 id="g7">7. Put it on your phone</h2>
        <p>On Android, open the browser menu and choose <strong>Install app</strong> (or <strong>Add to Home screen</strong>). On iPhone, tap Share, then <strong>Add to Home Screen</strong>. Then it opens like any app, works offline, and has a Record shortcut when you press and hold its icon.</p>
      </section>

      <section className="settings-section guide-section" id="guide-privacy" aria-labelledby="g8">
        <h2 id="g8">8. Who can see your notes</h2>
        <ul>
          <li>The recordings and transcripts are stored in <strong>your</strong> Google Drive.</li>
          <li>The voicebrain server reads them while it works (to transcribe and sort them). Whoever runs that server can, in principle, read them while it does. If that matters to you, run your own server.</li>
          <li>To pick out tasks and ideas, the written text is sent to an AI model. When you ask ChatGPT, the notes it reads are sent to OpenAI.</li>
          <li>You can delete any note for good, and disconnect Drive or sign out at any time.</li>
        </ul>
      </section>

      <section className="settings-section guide-section" id="guide-help" aria-labelledby="g9">
        <h2 id="g9">If something is wrong</h2>
        <dl className="faq">
          <dt>“This Google account is not on the list.”</dt><dd>Ask the owner to add your address, then try again.</dd>
          <dt>Notes show “Waiting”.</dt><dd>They are saved on your phone and upload when you are online and signed in. Open Settings to check you are signed in.</dd>
          <dt>“Google Drive is not connected.”</dt><dd>Open Settings and tap Connect Google Drive. This also happens if you removed voicebrain’s access in your Google account.</dd>
          <dt>ChatGPT cannot see my notes.</dt><dd>Check voicebrain is listed under Installed on ChatGPT’s Plugins page, and that you signed in with the same Google account as here. Try asking “Using voicebrain, …”.</dd>
          <dt>ChatGPT only uses voicebrain when I ask it to.</dt><dd>Add the custom instruction from step 5 (Personalization → Custom instructions). Until then you can always say “Using voicebrain, …”.</dd>
          <dt>ChatGPT does not know about a new feature.</dt><dd>Open the Plugins page and press the refresh button next to Add.</dd>
          <dt>The app looks old.</dt><dd>Close it completely and open it again. It updates itself in the background.</dd>
        </dl>
      </section>
    </div>
  </main>
}
