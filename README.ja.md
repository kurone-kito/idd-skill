# IDD Skill — Issue-Driven Development ワークフロー

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: [English](./README.md) | **日本語**

単発プロンプトの AI 実装を、issue の完了まで回り続ける GitHub ネイティブな
開発ループへ。

IDD Skill は、リポジトリへ移植できる Issue-Driven Development
ワークフローです。エージェントは着手できる issue を探して担当を宣言し、
ブランチで実装し、PR を開き、レビュー指摘を反映し、CI を待ち、マージと
後片づけまで進めます。ループ全体は、リポジトリ内に置かれた素の Markdown
指示ファイルとして配布されます — 読むのも、フォークするのも、監査するのも
自由です。

## IDD が存在する理由

有能なコーディングエージェントは、優れたチームメイトと同じように仕事を
終えるべきです — 見える形で、検証できる形で、最後まで。AI コーディングが
崩れるのは、コードを書く場面ではなく、その周辺のすべてです:

- 2 つのエージェントが同じ issue を拾ってしまう。
- レビュー指摘を採用したのに、修正が反映されない。
- CI が終わったころには、エージェントがもう見ていない。
- 新しいレビューが届いている途中で PR がマージされる。
- ルールがベンダーの画面の中に閉じていて、リポジトリから監査できない。

IDD は、これらの動きをひとつの監査可能な GitHub ネイティブのループに
まとめます。issue コメントには担当宣言、レビュー時点の記録、判断、
保留理由、後片づけのマーカーが残ります — どのエージェントも、状況を
推測せずに作業を再開できます。

## 得られるもの

- **衝突しにくい並列作業** — 担当宣言と heartbeat マーカーにより、中央の
  調整役なしで issue の担当が見えます。
- **止まりにくい PR** — PR を開いた後も、レビューコメント、CI、追加修正を
  追い続けます。
- **ブラックボックスではない移植可能なルール** — 導入先リポジトリで
  そのまま読める Markdown。閲覧も、フォークも、カスタマイズも自由です。
- **エージェントを選べる自由** — GitHub Copilot、Claude Code、OpenAI
  Codex CLI、OpenCode、Antigravity CLI (formerly Gemini CLI) で動作。
  標準の Copilot 助言レビューは
  [review policy profiles](docs/idd-review-policy-profiles.md) で
  差し替えられます。
- **運用するサービスが不要** — サーバーもスケジューラも SaaS アカウントも
  不要。テンプレートファイルを取り込むだけで始められます。

## 実運用の実績

IDD はデモではありません。このリポジトリ自体が IDD で作られています:

- private な業務リポジトリ群で、延べ **2,000 件以上の issue** を
  プルリクエスト化してマージ。
- この公開リポジトリ単体でも **700 件以上の PR** をマージ。x4-6 並列の
  multi-agent セッション(原型を運用した private 環境では x8-10)で
  dogfooding を継続中。
- **失敗ゼロは謳いません** — 実運用で見つかった境界条件は issue として
  ループに還流し、ループが自分自身を直します。

_2026-07 時点。_

## クイックスタート

IDD を導入したいリポジトリで AI エージェントのセッションを開き、
次のように依頼します:

> `github:kurone-kito/idd-skill` の IDD をこのリポジトリに導入してください。

明示的な URL が必要なエージェントには、次のように依頼します:

> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> を読んで、このリポジトリを Issue-Driven Development 用に
> セットアップしてください。

続けて、ループを開始します:

> このリポジトリで IDD ワークフローを開始してください。

エージェントは着手できる issue を探して担当を宣言し、実装、PR レビュー、
CI、選択したマージポリシー、後片づけまでループを進めます。初回導入の
詳しい導線(任意の IDD doctor 検証を含む)は
[Getting started](docs/getting-started.md) を参照してください。

### 前提条件

ループを最後まで実行するには、`git`、認証済みの `gh` CLI(または同等の
GitHub MCP 連携)、`jq`、`curl` などの REST クライアント、そして helper
スクリプトを使う場合は Node.js が必要です(詳細は
[Tooling boundary](docs/customization.md#tooling-boundary))。無人または
マージ可能なエージェントへ認証情報を渡す前に
[Permissions and threat model](docs/permissions.md) を確認し、merge
policy を [Customizing IDD](docs/customization.md) で 1 つ選んで
記録してください。

### AI エージェント向け

ユーザーが `github:kurone-kito/idd-skill` を示して IDD の導入を依頼
したら、まずこのファイルを取得し、その内容に正確に従ってください:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

コピーするファイル、埋める placeholder、更新する導入先リポジトリの
入口ファイルが説明されています。

## 仕組み

各フェーズには名前付きの役割、再開できるマーカー、次の手順があります:

| ステージ    | エージェントが行うこと                                                                     |
| ----------- | ------------------------------------------------------------------------------------------ |
| Discover    | ロードマップまたは単独 issue から着手できる作業を探し、範囲を勝手に広げません。            |
| Claim       | 機械可読な担当マーカーで 1 つの issue を予約します。                                       |
| Work        | ブランチと worktree を作り、計画、実装、セルフレビューを行います。                         |
| Submit PR   | push して PR を開き、レビューできる状態になるまで検証を待ちます。                          |
| Review Loop | レビューの動きを記録し、指摘を採用または見送り、採用した指摘を直します。                   |
| Merge       | 最新状態、助言レビュー、CI、未解決スレッド、コメント、選択したマージポリシーを確認します。 |
| Cleanup     | マージ完了後、安全な場合は古いマーカーを隠して、次の Discover へ戻ります。                 |

この設計は **loop engineering** — trigger・topology・verifier・
stop rules を仕組みとして設計する考え方(Anthropic のいう
**agentic loops**)— に従い、専用ランタイムではなく issue コメントの
永続状態のうえに実装されています。詳しい枠組みは
[Core concepts](docs/concepts.md#idd-as-loop-engineering)、フェーズの
全体像は [docs/idd-workflow.md](docs/idd-workflow.md) を参照して
ください。

## 実例で学ぶ

[VRChat Event Calendar ワークショップ](docs/workshop/README.md) を
読むと、IDD が実在のアプリを最初から最後まで組み上げる流れを追えます。
実装結果は実例リポジトリ
[`kurone-kito/vrc-event-calendar`](https://github.com/kurone-kito/vrc-event-calendar)
でも確認できます。

## 次の一歩

| 目的                                                | まず読む場所                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 概念を先に理解したい                                | [`docs/concepts.md`](docs/concepts.md)                                                                                                                                    |
| 自分のリポジトリに IDD を導入したい                 | [`idd-template/ONBOARDING.md`](idd-template/ONBOARDING.md)                                                                                                                |
| このリポジトリでエージェントを動かしたい            | [`AGENTS.md`](AGENTS.md)(Codex CLI と OpenCode)、[`CLAUDE.md`](CLAUDE.md)、[`GEMINI.md`](GEMINI.md)、[`.github/copilot-instructions.md`](.github/copilot-instructions.md) |
| ループの前に AI 向け issue を整備したい             | [`skills/issue-authoring/SKILL.md`](skills/issue-authoring/SKILL.md)                                                                                                      |
| review・merge・CI・discovery のポリシーを調整したい | [`docs/customization.md`](docs/customization.md)                                                                                                                          |
| それ以外のすべて — 完全なリファレンスマニュアル     | [`docs/index.md`](docs/index.md)                                                                                                                                          |

主なパッケージは [`idd-template/`](idd-template/) です。移植用の
`.github/instructions/` ファイル、導入・ワークフロードキュメント、
機械可読ポリシーファイル(`.github/idd/config.json`)を、採用者が
自分のリポジトリへコピーします。この source repository の
コントリビューター向けツール基盤は
[`.github/CONTRIBUTING.ja.md`](.github/CONTRIBUTING.ja.md) を参照して
ください。

## ライセンス

[MIT](./LICENSE)
