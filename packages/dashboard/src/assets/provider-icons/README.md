# Provider icon assets

## `codex-openai.png`: OpenAI's official Codex icon

Byte-for-byte copy of the icon OpenAI publishes for its own Codex IDE extension
on the Visual Studio Marketplace (publisher **OpenAI**, domain-verified;
extension `openai.chatgpt`, "Codex – OpenAI's coding agent", v26.5917.62051,
updated 2026-09-23):

    https://openai.gallerycdn.vsassets.io/extensions/openai/chatgpt/26.5917.62051/1790149959307/Microsoft.VisualStudio.Services.Icons.Default

- 385×385 RGBA PNG, 10,969 bytes
- sha256 `2ce1c57dd3b312417106a487815ab1235bddce17e1fa9b32a2f048bd71ee25d3`
- A white OpenAI Blossom on a black tile. The tile's own anti-aliased corners are part
  of the asset.

It is rendered **unaltered**: no recoloring, no filter, no border-radius, no
opacity. It is the same image in every theme (see `ui/provider-icon.tsx` and its tests).
It replaced a community-drawn "cloud >_" glyph (from `@lobehub/icons`) that
OpenAI does not publish (decision 2026-09-26; PR #410).

It was **not** taken from OpenAI's logo pack, whose download requires accepting
OpenAI's Marks usage terms. Use is referential, to show which runtime backs an
agent. See the repo `NOTICE`.

To refresh it, re-fetch from the Marketplace, update the version, URL and
sha256 above, and re-run `make hero`.
