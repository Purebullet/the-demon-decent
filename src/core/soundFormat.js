// The file type of the sound effects. The web build plays the WAVs that
// scripts/make-sounds.mjs renders; the Project 0 package carries them as
// MP3 (a tenth of the size), and its build rewrites this line to say so.
// The looping drone and intro loop stay WAV everywhere (MP3 pads its ends
// with silence).
export const SOUND_EXT = 'wav';

// The intro song's build (assets/sounds/intro), before its loop takes over.
export const INTRO_SECONDS = 44;
