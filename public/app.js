// Voice Claude - Frontend Application with Edge TTS

// State
let isRecording = false;
let recognition = null;
let conversationHistory = [];
let abortController = null;
let currentAudio = null;

// DOM Elements
const chat = document.getElementById('chat');
const emptyState = document.getElementById('emptyState');
const status = document.getElementById('status');
const micBtn = document.getElementById('micBtn');
const sendBtn = document.getElementById('sendBtn');
const textInput = document.getElementById('textInput');
const speakingIndicator = document.getElementById('speakingIndicator');
const settingsModal = document.getElementById('settingsModal');
const systemMessageInput = document.getElementById('systemMessage');
const autoSpeakCheckbox = document.getElementById('autoSpeak');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadHistory();
  setupSpeechRecognition();

  // Enter key to send
  textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Tap speaking indicator to stop TTS
  speakingIndicator.addEventListener('click', stopSpeaking);
});

// Speech Recognition Setup
function setupSpeechRecognition() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    setStatus('Speech recognition not supported', 'error');
    micBtn.disabled = true;
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-GB';

  recognition.onstart = () => {
    isRecording = true;
    micBtn.classList.add('recording');
    setStatus('Listening... tap mic when done', 'active');
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    textInput.value = transcript;
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    stopRecording();
    if (event.error !== 'aborted') {
      setStatus('Error: ' + event.error, 'error');
    }
  };

  recognition.onend = () => {
    if (isRecording) {
      // Auto-send when recognition ends (user tapped to stop)
      stopRecording();
      if (textInput.value.trim()) {
        sendMessage();
      }
    }
  };
}

// Toggle Recording
function toggleRecording() {
  // If audio is playing, stop it and start recording
  if (currentAudio && !currentAudio.paused) {
    stopSpeaking();
  }

  if (isRecording) {
    stopRecording();
    // Send the message if we have text
    if (textInput.value.trim()) {
      sendMessage();
    }
  } else {
    startRecording();
  }
}

function startRecording() {
  if (!recognition) return;

  textInput.value = '';
  try {
    recognition.start();
  } catch (e) {
    // Already started
  }
}

function stopRecording() {
  isRecording = false;
  micBtn.classList.remove('recording');
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {
      // Already stopped
    }
  }
  setStatus('Ready');
}

// Send Message
async function sendMessage() {
  const text = textInput.value.trim();
  if (!text) return;

  // Cancel any ongoing request
  if (abortController) {
    abortController.abort();
  }

  // Stop any TTS
  stopSpeaking();

  // Clear input
  textInput.value = '';

  // Hide empty state
  emptyState.style.display = 'none';

  // Add user message
  addMessage(text, 'user');
  conversationHistory.push({ role: 'user', content: text });
  saveHistory();

  // Create assistant message placeholder
  const assistantMsg = addMessage('', 'assistant', true);

  // Disable inputs
  setInputsEnabled(false);
  setStatus('Thinking...', 'active');

  try {
    abortController = new AbortController();

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversationHistory,
        systemMessage: systemMessageInput.value || undefined
      }),
      signal: abortController.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    // Handle streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);

            if (parsed.type === 'text') {
              fullResponse += parsed.content;
              assistantMsg.textContent = fullResponse;
              scrollToBottom();
            } else if (parsed.type === 'tool_call') {
              addMessage(`🔧 Calling: ${parsed.name}`, 'tool-call');
              setStatus(`Calling ${parsed.name}...`, 'active');
            } else if (parsed.type === 'tool_result') {
              addMessage(`✓ ${parsed.name}: ${parsed.result.substring(0, 100)}...`, 'tool-result');
            } else if (parsed.type === 'error') {
              throw new Error(parsed.message);
            }
          } catch (e) {
            if (e.message !== 'Unexpected end of JSON input') {
              console.error('Parse error:', e);
            }
          }
        }
      }
    }

    // Finalize
    assistantMsg.classList.remove('streaming');
    conversationHistory.push({ role: 'assistant', content: fullResponse });
    saveHistory();

    // Speak response using Edge TTS
    if (autoSpeakCheckbox.checked && fullResponse) {
      speak(fullResponse);
    }

    setStatus('Ready');

  } catch (error) {
    if (error.name === 'AbortError') {
      setStatus('Cancelled');
    } else {
      console.error('Error:', error);
      assistantMsg.textContent = 'Error: ' + error.message;
      assistantMsg.classList.add('error');
      setStatus('Error occurred', 'error');
    }
  } finally {
    setInputsEnabled(true);
    abortController = null;
  }
}

// Add message to chat
function addMessage(content, role, streaming = false) {
  const msg = document.createElement('div');
  msg.className = `message ${role}${streaming ? ' streaming' : ''}`;
  msg.textContent = content;
  chat.appendChild(msg);
  scrollToBottom();
  return msg;
}

// Text-to-Speech using Edge TTS API
async function speak(text) {
  // Clean text for speech (remove markdown, etc.)
  const cleanText = text
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~`]/g, '');

  if (!cleanText.trim()) return;

  try {
    setStatus('Generating speech...', 'active');
    speakingIndicator.classList.add('active');

    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleanText })
    });

    if (!response.ok) {
      throw new Error(`TTS error: ${response.status}`);
    }

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    
    currentAudio = new Audio(audioUrl);
    
    currentAudio.onended = () => {
      speakingIndicator.classList.remove('active');
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      setStatus('Ready');
    };

    currentAudio.onerror = () => {
      speakingIndicator.classList.remove('active');
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      setStatus('Audio playback error', 'error');
    };

    await currentAudio.play();
    setStatus('Speaking...', 'active');

  } catch (error) {
    console.error('TTS error:', error);
    speakingIndicator.classList.remove('active');
    setStatus('TTS error: ' + error.message, 'error');
  }
}

function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  speakingIndicator.classList.remove('active');
  setStatus('Ready');
}

// UI Helpers
function setStatus(text, type = '') {
  status.textContent = text;
  status.className = 'status-bar' + (type ? ' ' + type : '');
}

function setInputsEnabled(enabled) {
  textInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  micBtn.classList.toggle('processing', !enabled);
}

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

// Settings
function openSettings() {
  settingsModal.classList.add('active');
}

function closeSettings() {
  settingsModal.classList.remove('active');
}

function saveSettings() {
  localStorage.setItem('voiceClaude_systemMessage', systemMessageInput.value);
  localStorage.setItem('voiceClaude_autoSpeak', autoSpeakCheckbox.checked);
  closeSettings();
}

function loadSettings() {
  const savedSystemMessage = localStorage.getItem('voiceClaude_systemMessage');
  const savedAutoSpeak = localStorage.getItem('voiceClaude_autoSpeak');

  if (savedSystemMessage) {
    systemMessageInput.value = savedSystemMessage;
  } else {
    // Default voice-optimized prompt
    systemMessageInput.value = `You are a helpful voice assistant. Keep responses concise and conversational.
Spell out numbers when speaking (say "twenty-three" not "23").
Avoid emojis, special characters, and markdown formatting.
Be direct and natural - this is a voice conversation.`;
  }

  if (savedAutoSpeak !== null) {
    autoSpeakCheckbox.checked = savedAutoSpeak === 'true';
  }
}

// Chat History
function saveHistory() {
  localStorage.setItem('voiceClaude_history', JSON.stringify(conversationHistory));
}

function loadHistory() {
  const saved = localStorage.getItem('voiceClaude_history');
  if (saved) {
    try {
      conversationHistory = JSON.parse(saved);
      if (conversationHistory.length > 0) {
        emptyState.style.display = 'none';
        conversationHistory.forEach(msg => {
          addMessage(msg.content, msg.role);
        });
      }
    } catch (e) {
      conversationHistory = [];
    }
  }
}

function clearChat() {
  if (confirm('Clear all messages?')) {
    conversationHistory = [];
    localStorage.removeItem('voiceClaude_history');
    chat.innerHTML = '';
    chat.appendChild(emptyState);
    emptyState.style.display = 'flex';
  }
}
