# Built-in Anki decks

Copy `.apkg` files into this folder and run `python standalone/build.py`. The cards of every
deck are embedded into the built app and appear under Vocabulary → "Built-in decks", where one
click adds them to the vocabulary of a language pair. Media (audio, pictures) is left out.

- `Name.de-en.apkg` presets the language pair; otherwise it is read from the field names or
  detected in the app, and confirmed before adding.
- The `.apkg` files themselves are not committed (see `.gitignore`); the built HTML carries
  the cards. `python standalone/decks.py` lists what the build would embed.
