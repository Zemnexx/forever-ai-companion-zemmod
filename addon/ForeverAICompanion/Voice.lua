-- Invisible channel: the game's text-to-speech API with the silent
-- "ForeverAICompanion" voice installed by the companion app (a SAPI voice on
-- Windows, a speech synthesis extension inside the app on macOS). The system
-- hands the "spoken" text to that voice, which passes it to the app: nothing
-- is drawn and nothing is heard. Used whenever the voice exists; otherwise the strip.
--
-- Messages: "FAIC:<request id>:<part>/<parts>:<base64 chunk of the frame>".
local _, ns = ...

local Voice = {}
ns.Voice = Voice

-- Measured in WoW Forever: a phrase of 16 000 characters arrives intact, one
-- of 64 000 is cut at 29 997; and the voice still gets the text at volume 0.
-- Every phrase makes Windows open the sound output for an instant, which some
-- PCs hear as a faint "pop": as few phrases as possible, so a normal question
-- (12-18 000 characters) goes in one. 24 000 + the header stays well under the cut.
Voice.CHUNK = 24000            -- base64 characters per spoken message
Voice.VOLUME = 0               -- volume passed to SpeakText
Voice.MAX_FRAME_BYTES = 60000  -- no screen limits on this channel

local floor, ceil = math.floor, math.ceil
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function Voice.Base64(s, step)
  local out = {}
  for i = 1, #s, 3 do
    local a, b, c = s:byte(i, i + 2)
    local n = a * 65536 + (b or 0) * 256 + (c or 0)
    local c1, c2 = floor(n / 262144) % 64, floor(n / 4096) % 64
    local c3, c4 = floor(n / 64) % 64, n % 64
    out[#out + 1] = B64:sub(c1 + 1, c1 + 1) .. B64:sub(c2 + 1, c2 + 1)
      .. (b and B64:sub(c3 + 1, c3 + 1) or "=") .. (c and B64:sub(c4 + 1, c4 + 1) or "=")
    if step and i % 3000 == 1 then step() end
  end
  return table.concat(out)
end

function Voice:Find()
  local get = C_VoiceChat and C_VoiceChat.GetTtsVoices
  if not get then return nil end
  local ok, list = pcall(get)
  -- "ForeverAICompanion". Installs from before the rename still have the voice
  -- under the project's previous name; it keeps working until the app updates it.
  local legacy
  for _, v in ipairs(ok and type(list) == "table" and list or {}) do
    if type(v.name) == "string" then
      if v.name:find("^ForeverAICompanion") then return v.voiceID end
      if v.name:find("^AzerothIA") then legacy = v.voiceID end
    end
  end
  return legacy
end

function Voice:Available()
  if self.broken then return false end
  self.voiceID = self:Find()
  return self.voiceID ~= nil
end

-- SpeakText changed signature across game versions; remember what works.
function Voice:Speak(text, volume)
  local speak = C_VoiceChat and C_VoiceChat.SpeakText
  if not speak then return false end
  volume = volume or self.VOLUME
  if self.signature ~= "old" then
    -- (voiceID, text, rate, volume, overlap): overlap queues instead of cutting.
    if pcall(speak, self.voiceID, text, 0, volume, true) then
      self.signature = "new"
      return true
    end
  end
  if self.signature ~= "new" then
    local localPlayback = Enum and Enum.VoiceTtsDestination and Enum.VoiceTtsDestination.LocalPlayback or 1
    if pcall(speak, self.voiceID, text, localPlayback, 0, volume) then
      self.signature = "old"
      return true
    end
  end
  return false
end

-- /ia test-voice (probar-voz): what the game sees and whether speaking works.
function Voice:Diagnose()
  local L = ns.L
  local say = function(msg) print("|cff66ccff" .. L.VOICE_PREFIX .. "|r " .. msg) end
  local get = C_VoiceChat and C_VoiceChat.GetTtsVoices
  if not get then say(L.VOICE_NO_API) return end
  local ok, list = pcall(get)
  if not ok then say(string.format(L.VOICE_LIST_FAILED, tostring(list))) return end
  for _, v in ipairs(list or {}) do say(string.format(L.VOICE_ITEM, tostring(v.voiceID), tostring(v.name))) end
  self.broken = nil
  if not self:Available() then
    say(L.VOICE_NOT_FOUND)
    return
  end
  local spoken = self:Speak("FAIC-VOICE-TEST volume100 " .. time(), 100)
  if not spoken then
    say(L.VOICE_SPEAK_FAILED)
    return
  end
  say(string.format(L.VOICE_TESTING, tostring(self.signature)))
  -- Does the voice still get the text at volume 0? How long can one phrase be?
  local tests = {
    function() self:Speak("FAIC-VOICE-TEST volume0 " .. time(), 0) end,
    function() self:Speak("FAIC-VOICE-LONG " .. self.CHUNK .. " " .. string.rep("x", self.CHUNK), 0) end,
    function() self:Speak("FAIC-VOICE-LONG 64000 " .. string.rep("x", 64000), 0) end,
  }
  for i, fn in ipairs(tests) do
    C_Timer.After(i * 1.5, function()
      fn()
      if i == #tests then say(L.VOICE_DONE) end
    end)
  end
end

-- Sends a frame (from Uplink.Frame). Returns true when every part was spoken.
function Voice:Send(frame, id, step)
  local data = Voice.Base64(frame, step)
  local parts = ceil(#data / self.CHUNK)
  for i = 1, parts do
    local chunk = data:sub((i - 1) * self.CHUNK + 1, i * self.CHUNK)
    if not self:Speak(string.format("FAIC:%s:%d/%d:%s", id, i, parts, chunk)) then
      self.broken = true
      return false
    end
    if step then step() end
  end
  self.lastSend = { bytes = #frame, parts = parts }
  return true
end
