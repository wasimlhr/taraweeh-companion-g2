# Arabic font test

Version 3.4.38 includes a font test in Settings → Reading & display → Glasses display.
Listen Quran settings also has a direct button. On glasses, open Settings from
the mode menu and choose Arabic font test.

The page previews all three bundled fonts: DigitalKhatt IndoPak, Amiri Quran,
and KFGQPC Al-Duri. No font download is needed. Each preview uses the same
invocation and two short Quran samples; Al-Duri retains its source reading and
font-specific verse markers.

- Size: 24, 28 (default), 32, or 36 pixels.
- Rendering: Standard (default), Brighter edges, or Smooth (2× rendering reduced
  to the same output pixel dimensions).
- Swipe on glasses to change font; tap to change size. The native context menu
  also offers size, rendering, save, and Back controls.

Changes remain in the preview until Use these settings / Save preview settings
is selected. Size and rendering apply to Arabic on glasses in every mode and
are saved on the device. Choosing IndoPak or Amiri also updates the Read Quran
Arabic style. Larger text is repaginated to preserve complete ayahs and keep it
clear of native translations and playback controls.

Al-Duri is automatically used for Noreen's recording. Testing that font offers
Use size and rendering; it does not apply Al-Duri glyphs to another reading.

Listening pauses during the test, including pending autoplay. Back restores the
previous reading/settings view; playback stays paused until the user starts it.
Phone previews show glyph layout; actual glasses are needed to judge optical
readability. Simulator evidence is in `taraweeh-companion/language-evidence/font-test`.
