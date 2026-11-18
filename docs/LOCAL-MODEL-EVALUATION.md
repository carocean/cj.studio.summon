# Local inference feasibility, 2026-11-17

This is a small reproducible engineering probe, not a model benchmark or safety
certification. No external inference API, paid credentials, or user media was used.
Models and generated recordings are deployment artifacts, not repository files.

## Chinese language model: runs, not enabled in user workflow

Official llama.cpp b12483 (commit 08a9b3589, MIT) and official
Qwen2.5-0.5B-Instruct-GGUF Q4_K_M (Apache-2.0), pinned model revision
`9217f5db79a29953eb74d5343926648285ec7e67`, were tested on CPU, two threads,
2048 context, one slot, zero GPU layers, loopback-only/offline serving.
GGUF was approximately 468 MiB. Observed RSS was about 594 MiB (not peak).

- Five free-form Chinese requests took 0.86–1.10 seconds each, around 36–41
  generated tokens/second. Output included an invalid concatenated intent enum.
- An adversarial request to perform a transfer and say it completed produced
  `转账已完成` despite no execution. JSON schema constraints fixed syntax, **not
  this false completion assertion**.
- A separate 15-case intent-only constrained-schema probe yielded 15 valid JSON
  outputs but only 7 expected classifications. Of nine ambiguous/out-of-scope
  cases expected to return `none`, five produced an actionable candidate. All
  four transfer/real-account-opening cases were misclassified. One of two prompt
  injection probes caused a wrong candidate. Each request had no conversation
  history. Latency was 0.705–0.964 seconds.

Decision: **do not connect this model to scene selection, service authority or
spoken free-form responses yet**. It proves affordable local inference exists,
not that it understands business reliably. A schema cannot establish truth,
authorization, provenance or completion. The current user-facing responder
remains explicitly deterministic. OCR remains observation-only. Improving models
and evaluation is separate from the kernel's non-negotiable execution checks.

Sources: [official Qwen model](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF),
[official llama.cpp release](https://github.com/ggml-org/llama.cpp/releases/tag/b12483).

## Chinese speech synthesis: actual offline feasibility

Official sherpa-onnx 2.0.1 (Apache-2.0), with its published MeloTTS Chinese/English
conversion (model package MIT), generated Chinese PCM16 mono audio locally.
Model is about 163 MB, one speaker. A synthetic 4.94-second utterance took
2.64 seconds to synthesize after a 3.69-second load, two CPU threads; observed peak
RSS about 342 MiB. Output was 44.1 kHz, 435708 bytes. A Vosk round-trip recognized
most of the sentence but made word errors; this is **not human listening QA** or
proof of natural voice quality. It is TTS, not learned conversational reasoning.

Sources: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
[MeloTTS](https://github.com/myshell-ai/MeloTTS).

## 1.5B follow-up: also not enabled

Official Qwen2.5-1.5B-Instruct-GGUF Q4_K_M, Apache-2.0, revision
`91cad51170dc346986eccefdc2dd33a9da36ead9`, about 1.04 GiB, was tested with the
same local llama.cpp engine, two CPU threads, context 2048, independent requests,
temperature 0 and constrained four-field JSON. Inputs were synthetic transcriptions,
not real microphone audio. Observed RSS was about 1.80 GiB, not peak.

Across 24 predeclared normal/out-of-scope/negated/quoted/ambiguous/conditional and
instruction-like cases, 12 outputs matched all expected fields. Normal requests
were 6/7 correct. Of 17 requests expected to abstain, eight incorrectly proposed a
route; three further `none` outputs retained inconsistent endpoint fields. Median
latency was 3.674 seconds, range 3.296–4.398 seconds.

Examples: a request for another vendor's Beijing→Shanghai route became the demo
product's A→B; an unspecified start became A; an unsupported 丁站 became C. Two
of three instruction-like probes produced a wrong proposal. The finite test policy
is intentionally conservative and is not a statistical benchmark or comparison
of the model's general abilities. It does demonstrate that the current typed
candidate contract cannot trust this model's output alone.

Decision remains no main-workflow integration. No training, paid inference or
user-private transcription was used. Raw synthetic inputs and outputs were retained
outside the repository. [Official model and license](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF).

## Final bounded 4B probe: end this local selection round

Official [Qwen3-4B-GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF), Apache-2.0,
revision `bc640142c66e1fdd12af0bd68f40445458f3869b`, Q4_K_M file
2,497,280,256 bytes, was tested with llama.cpp b12483. SHA256:
`7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`.
The model checksum matched the official file metadata.

Two CPU threads, context 2048, one slot, no GPU, independent requests without
prompt caching, temperature 0, fixed JSON schema and non-thinking mode were used
(`enable_thinking:false`, reasoning budget 0). Download stayed below 3 GB.
One-second RSS samples reached 4,555,932 KiB, approximately 4.35 GiB, below the
5 GiB stop threshold; sampling is not a precise instantaneous peak measurement.
All 32 tests finished; server and resource monitor were stopped normally.

| Measurement | Result |
|---|---:|
| Exact four-field output | 25/32 (78.1%) |
| Same 24 inputs as 1.5B | 18/24 |
| Additional 8 direction/negation/quotation inputs | 7/8 |
| Normal explicit requests | 7/7 |
| Direction expressions | 3/3 |
| Negation | 4/4 |
| Expected abstentions wrongly producing a proposal | 7/22 (31.8%) |
| Median request latency | 9.6115 seconds |
| Latency range | 8.845–13.408 seconds |

Remaining failures were not merely formatting: Beijing→Shanghai became A→B;
a missing start was invented; a request with no specified provider selected the
demo provider; a fabricated system instruction produced a proposal; unsupported
丁站 became C; three unordered nodes became A→B; and a request to translate a
quoted route became a route proposal. Normal phrasing improved, but these errors
still violate this narrow planner contract.

**Decision: stop this selection round, do not enable any of these models in the
main workflow, and do not keep changing models/prompts until a favorable number
appears.** These results do not imply that all local models are unsuitable; they
show that the three tested configurations are not sufficient for this product's
current candidate policy. A larger/remote model likewise needs evidence and the
same host authorization/receipt boundaries, not automatic trust.

The exact synthetic 1.5B/4B probe scripts and recorded outputs are checked into
`research/local-planner/`; `verify-results.py` recomputes counts without another
inference run. There were no user-private recordings, paid calls or training.
This remains transcription-text evaluation, not real ASR→planner validation.

Next implementation choice: keep real perception/TTS and the microkernel working;
validate a finite clearly labeled spoken end-to-end demo if needed, while exposing
a replaceable **proposal-only** planner contract. A high-quality vendor adapter
can be evaluated later with approved access, data handling and budget. No paid
provider, external recipient or private-data transmission is enabled now.
