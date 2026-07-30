# Third-party notices

## Defuddle

LLM Wiki bundles portions of [Defuddle](https://github.com/kepano/defuddle),
Copyright (c) 2025 Steph Ango (@kepano), under the MIT License:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## OpenAI JavaScript SDK

[openai-node](https://github.com/openai/openai-node), version 6.x,
is Copyright OpenAI and distributed under the Apache License 2.0.
The complete license text is available in the upstream repository and at
<https://www.apache.org/licenses/LICENSE-2.0>.

## Anthropic TypeScript SDK

[anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript),
Copyright 2023 Anthropic, PBC, is distributed under the MIT License.

## PDF.js

[pdfjs-dist](https://github.com/mozilla/pdf.js), version 5.x, is distributed
under the Apache License 2.0. The complete license text is available in the
upstream repository and at <https://www.apache.org/licenses/LICENSE-2.0>.

## fflate

[fflate](https://github.com/101arrowz/fflate), version 0.8.x,
Copyright (c) 2020 Arjun Barrett, is distributed under the MIT License.

## YAML

[yaml](https://github.com/eemeli/yaml), version 2.x, is distributed under
the ISC License.

## jsonrepair

[jsonrepair](https://github.com/josdejong/jsonrepair), version 3.x,
Copyright (c) 2020 Jos de Jong, is distributed under the ISC License.

The ISC License permits use, copy, modification and distribution for any
purpose with or without fee, provided that the copyright notice and permission
notice appear in all copies. The software is provided "as is", without
warranty of any kind.

## License preservation in the production bundle

The production build uses esbuild `legalComments: "eof"` so dependency license
comments that are present in bundled source remain attached to `main.js`.
The complete upstream license files remain authoritative.

## Bilibili Obsidian Clipper reference

The public-caption acquisition design was informed by
[Bilibili Obsidian Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper),
an MIT-licensed project. T-Wiki uses its own restricted networking and storage
implementation and does not require cookies or browser-session credentials.

## yt-dlp optional external tool

T-Wiki can invoke a user-installed copy of
[yt-dlp](https://github.com/yt-dlp/yt-dlp) to acquire public Douyin videos.
yt-dlp is not bundled with or redistributed by this plugin. It is licensed
under The Unlicense; optional components used by yt-dlp may have their own
licenses. Users are responsible for installing the tool and for complying
with the source platform's terms and applicable copyright law.
