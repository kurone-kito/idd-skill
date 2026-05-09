# IDD Skill — Issue-Driven Development ワークフロー

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: [English](./README.md) | **日本語**

複数の AI エージェントが GitHub Issues から作業しても、互いの作業を踏まないようにします。

IDD Skill は、リポジトリへ移植できる Issue-Driven Development
ワークフローです。エージェントは ready な issue を探し、所有権を claim し、
branch を切って実装し、PR を開き、review feedback を処理し、CI を待ち、
merge して cleanup します。ループ全体は、リポジトリ内の Markdown
instruction files として保持されます。

最初の PR を開いたところで AI エージェントが止まるのではなく、その後の
handoff まで進み続けてほしいチームに向いています。

## IDD が選ばれる理由

AI coding agent は強力ですが、チームの workflow はすぐに散らかります:

- 2 つの agent が同じ issue を拾ってしまう。
- review comment を accepted にしたのに、修正が反映されない。
- CI が終わった時点で、agent がもう見ていない。
- 新しい review activity が届いている途中で PR が merge される。
- workflow rule が vendor platform の中に隠れて、repo から監査できない。

IDD Skill は、これらの動きを GitHub-native で監査可能なループにします。
Issue comment には claim、review snapshot、判断、hold、cleanup marker が残るため、
別の agent が再開しても状況を推測する必要がありません。

## クイックスタート

### IDD をインストールする

IDD を導入したいリポジトリで AI agent の session を開き、次のように依頼します:

> `github:kurone-kito/idd-skill` の IDD をこのリポジトリに
> import and onboard してください。

明示的な URL が必要な agent には、次のように依頼します:

> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> を読んで、このリポジトリを Issue-Driven Development 用に
> onboard してください。

Onboarding guide は project-specific な値を集め、portable template をコピーし、
agent entry files を更新します。agent が必要な GitHub access を持っていれば、
手動ファイルコピーは不要です。

### ループを実行する

onboarding 後、対象リポジトリで agent を起動して次のように依頼します:

> このリポジトリで IDD workflow を開始してください。

agent は workflow guide を読み、ready な issue を探して claim し、work、PR review、
CI、merge、cleanup までループを進めます。

ループを end-to-end で実行するには、agent が `git`、認証済みの `gh` CLI
または同等の GitHub MCP integration、`jq`、`npx` を使える Node.js/npm、
そして operational marker を確実に投稿するための `curl` などの REST client に
アクセスできる必要があります。詳細な command contract は workflow docs を
参照してください。

## IDD が自動化すること

IDD は、良い意味で退屈な workflow です。各 phase には名前付きの役割、
再開可能な marker、次の手順があります。

| ステージ    | Agent が行うこと                                                                           |
| ----------- | ------------------------------------------------------------------------------------------ |
| Discover    | roadmap または orphan issue から ready な作業を探し、scope を勝手に広げません。            |
| Claim       | 機械可読な ownership marker で 1 つの issue を予約します。                                 |
| Work        | branch/worktree を作り、plan、implement、self-review を行います。                          |
| Submit PR   | push して PR を開き、review 可能になるまで validation を待ちます。                         |
| Review Loop | review activity を記録し、feedback を accept / reject し、accepted items を直します。      |
| Merge       | freshness、advisory review state、CI、unresolved threads、comments を再確認します。        |
| Cleanup     | 検証済み HEAD を merge し、安全な場合は stale marker を隠して、次の discovery へ戻ります。 |

完全な phase map は [docs/idd-workflow.md](docs/idd-workflow.md) と
`.github/instructions/` にあります。

## 得られるもの

- **衝突しにくい並列作業** — claim と heartbeat marker によって、中央
  coordinator なしで issue ownership が見えるようになります。
- **止まりにくい PR** — initial pull request を開いた後も、review comment、CI、
  follow-up fix を追い続けます。
- **black box ではない portable rule** — workflow は target repo 内の plain
  Markdown として残り、読めて、fork できて、customize できます。
- **agent を選べる自由** — core loop は GitHub Copilot、Claude Code、OpenAI
  Codex CLI、Gemini CLI で動作します。distributed default PR policy には
  Copilot advisory review step が含まれます。
- **運用する service が不要** — template files を import すれば始められます。
  separate server、scheduler、SaaS account は不要です。

より詳しい positioning は
[docs/positioning.md](docs/positioning.md) を参照してください。

## このリポジトリが配布するもの

主な package は [`idd-template/`](idd-template/) です。これは adopter が自分の
repository にコピーする portable な `.github/instructions/` files、onboarding
docs、workflow docs のセットです。

この repository には、異なる agent がここでどこから始めるかを知るための互換 entry
files として `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、
`.github/copilot-instructions.md` も含まれます。

Native `SKILL.md` bundle は optional companion です。issue drafting など
pre-execution task には役立ちますが、portable instruction template を
置き換えるものではありません。

## AI エージェント向け

ユーザーが `github:kurone-kito/idd-skill` を示して IDD onboarding を依頼したら、
まずこの file を取得してください:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

その内容に正確に従ってください。copy する files、埋める placeholders、
更新する target-repository entry files が説明されています。

## リクエストが大きすぎるとき

request の分解、dependency encoding、roadmap / sub-issue drafting が必要な場合は、
IDD execution loop の前に optional issue-authoring companion を使ってください。

この repository では、agent に次のように依頼します:

- `$issue-authoring skill を使って IDD-ready な issue を draft してください。`
- `skills/issue-authoring/SKILL.md を開いて issue set を準備してください。`

Issue authoring は issue draft と hygiene を準備するだけです。issue の公開や
Discover -> Claim -> Work の開始には、引き続き明示的な承認が必要です。

## 詳細リファレンス

- [リファレンスマニュアル](docs/index.md) — 詳細ドキュメント群への
  task-oriented な入口。
- [Workflow guide](docs/idd-workflow.md) — entry points、file map、
  cross-agent routing。
- [Positioning](docs/positioning.md) — competitive landscape と IDD の違い。
- [Issue authoring contract](docs/issue-authoring-skill.md) — optional
  pre-execution issue drafting model。
- [Comment minimization](docs/idd-comment-minimization.md) —
  post-merge cleanup policy。
- [Template import guide](idd-template/ONBOARDING.md) — target repository
  向けの raw onboarding instructions。

## ライセンス

[MIT](./LICENSE)
