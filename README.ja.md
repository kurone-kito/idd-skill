# IDD Skill — Issue-Driven Development ワークフロー

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: [English](./README.md) | **日本語**

単発プロンプトの AI 実装を、issue の完了まで回り続ける GitHub ネイティブな
開発ループへ。

IDD Skill は、リポジトリへ移植できる Issue-Driven Development
ワークフローです。エージェントは着手できる issue を探し、担当を宣言し、
ブランチを切って実装し、PR を開き、レビュー指摘を反映し、CI を待ち、
選択したマージポリシーに従ってマージと後片づけまで進めます。ループ全体は、
リポジトリ内の Markdown で書かれた指示ファイルとして管理されます。

## ループエンジニアリングとしての IDD

この開発ループは、**loop engineering**（エージェントの trigger・topology・
verifier・stop rules を仕組みとして設計する考え方）の具体例です。
Anthropic は同じ考え方を **agentic loops** と呼んでいます。IDD は、
専用ランタイムではなく issue コメントの永続状態のうえに構築された、
移植可能で GitHub ネイティブな実装です:

| ループの要素 | IDD での実装                                                                             |
| ------------ | ---------------------------------------------------------------------------------------- |
| Trigger      | Discover が着手できる issue を選びます。                                                 |
| Topology     | フェーズパイプライン、ロードマップの子 issue 分解、worktree で分離した並列エージェント。 |
| Verifier     | CI ゲートと advisory bot（Copilot / CodeRabbit / Codex）、レビュー triage。              |
| Stop rules   | Merge ゲート（claim・鮮度・CI・advisory・レビュー）。issue のクローズが終了条件です。    |

強力な verifier と stop-gate が重要な理由は
[Core concepts](docs/concepts.md#idd-as-loop-engineering)
を参照してください。

## 実例で学ぶ

[VRChat Event Calendar ワークショップ](docs/workshop/README.md) を読むと、
IDD が実在のアプリを最初から最後まで組み上げる流れを追えます。実装結果は
対応する実例リポジトリ
[`kurone-kito/vrc-event-calendar`](https://github.com/kurone-kito/vrc-event-calendar)
でも確認できます。

## 最初の入口（ペルソナ別ナビゲーション）

初見の場合は、目的に合う入口から始めてください:

| 目的                                     | まず読む場所                                                                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 概念を先に理解したい                     | [`docs/concepts.md`](docs/concepts.md)                                                                                                                                      |
| 自分のリポジトリに IDD を導入したい      | [`idd-template/ONBOARDING.md`](idd-template/ONBOARDING.md)                                                                                                                  |
| このリポジトリでエージェントを動かしたい | [`AGENTS.md`](AGENTS.md)（Codex CLI と OpenCode）、[`CLAUDE.md`](CLAUDE.md)、[`GEMINI.md`](GEMINI.md)、[`.github/copilot-instructions.md`](.github/copilot-instructions.md) |
| ポリシーを調整したい                     | [`docs/customization.md`](docs/customization.md)                                                                                                                            |
| AI 向けに issue を整備したい             | [`skills/issue-authoring/SKILL.md`](skills/issue-authoring/SKILL.md)                                                                                                        |

## IDD が選ばれる理由

AI コーディングエージェントは強力です。ただ、チームの開発フローに入れると、
すぐに細かなほころびが出てきます:

- 2 つのエージェントが同じ issue を拾ってしまう。
- レビュー指摘を採用したのに、修正が反映されない。
- CI が終わったころには、エージェントがもう見ていない。
- 新しいレビューが届いている途中で PR がマージされる。
- ルールがベンダーの画面の中に閉じていて、リポジトリから監査できない。

IDD Skill は、これらの動きを GitHub 上で監査できるループにします。
issue コメントには担当宣言、レビュー時点の記録、判断、保留理由、後片づけの
マーカーが残ります。別のエージェントが再開しても、状況を推測する必要は
ありません。

## クイックスタート

### IDD をインストールする

IDD を導入したいリポジトリで AI エージェントのセッションを開き、
次のように依頼します:

> `github:kurone-kito/idd-skill` の IDD をこのリポジトリに導入してください。

明示的な URL が必要なエージェントには、次のように依頼します:

> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> を読んで、このリポジトリを Issue-Driven Development 用に
> セットアップしてください。

導入ガイドはプロジェクト固有の値を確認し、移植用テンプレートをコピーし、
各エージェントの入口ファイルを更新します。エージェントが必要な GitHub
アクセス権を持っていれば、手作業でファイルをコピーする必要はありません。

### ループを実行する

導入後、対象リポジトリでエージェントを起動して次のように依頼します:

> このリポジトリで IDD ワークフローを開始してください。

エージェントはワークフローガイドを読み、着手できる issue を探して担当を宣言し、
実装、PR レビュー、CI、選択したマージポリシー、後片づけまでループを進めます。

### IDD doctor で導入状態を検証する（任意）

IDD 導入後、helper を配置済みのリポジトリ（この source repository には
同梱）で doctor スクリプトを一度実行すると、設定ズレを早期に検出できます:

```sh
node scripts/idd-doctor.mjs
```

レポートでは、IDD の主要ファイル有無、未解決 placeholder、
marker prefix の整合性、Project commands の妥当性、さらに `gh`
アクセス可能な場合は branch protection / required checks のシグナルを確認します。

## リアリティチェック

IDD は Markdown ネイティブですが、依存関係なしではありません。

ループを最後まで実行するには、エージェントに次が必要です:

- `git`
- 認証済みの `gh` CLI または同等の GitHub MCP 連携
- `jq`
- `curl` などの REST クライアント
- `npx` を使える Node.js/npm（非 Node.js プロジェクトでは任意 — 詳細は
  [Tooling boundary](docs/customization.md#tooling-boundary) を参照）
- 選択した merge policy に合う repository-scoped GitHub credentials
- ループで使う場合は、設定済みの branch protection / required review policy

必要なコマンドの詳細はワークフロードキュメントを参照してください。無人または
マージ可能なエージェントへ認証情報を渡す前に、
[Permissions and threat model](docs/permissions.md) も確認してください。
分散デフォルトでは、worker session がマージを通して続行する
(`fully_autonomous_merge`) ことを許可します。
`human_merge` と `separate_merge_agent` では、マージ権限を worker session
の外に置き、明示的な opt-in により選択します。merge policy は
[Customizing IDD](docs/customization.md) で 1 つ選んで記録します。

## フットプリントと導入規模の目安

IDD は instruction の増加を機械的に上限管理します。下表に記載する
2 つのファイル単位上限はハードコードですが、変動の大きいバンドル単位
上限はハードコードせず下記 `jq` コマンドで manifest から直接読むため、
バンドル値はドキュメント上で drift しません。

| 予算タイプ                      | 維持される値 |
| ------------------------------- | ------------ |
| 常時ロード instruction ファイル | 20,000 bytes |
| フェーズ instruction ファイル   | 35,500 bytes |

正規の値と所有箇所は
[Policy constants: Runtime Instruction Size and Bundle Budgets](docs/policy-constants.md#runtime-instruction-size-and-bundle-budgets)
を参照してください。

source repository の最新フットプリント証跡を確認するには:

```sh
node scripts/audit-docs.mjs --check
jq '.instructionSizeBudgets, .bundleBudgets' audit/sync-manifest.json
```

`audit-docs` は現在の instruction ファイルが維持予算内かを検証し、
`sync-manifest.json` はその予算契約を保持します。

導入先では、実運用時のループ負荷は helper runtime の選択で変わります:

- E/F フェーズの文脈負荷を下げたい場合は helper runtime 対応を優先
  します（helper は証跡収集のみで、マージや mutation の判断は引き続き
  instruction のゲートに従います）。
- Node.js / helper tooling を使わない方針なら `instructions-only` を選び、
  shell/`gh`/`jq` の手動経路を維持します。
- どちらの場合も、ローカル policy 追加、ローカル docs、追加 instruction
  により実効フットプリントは source repository より小さくも大きくもなりえます。

プロファイル選定時は
[ONBOARDING Step 1B policy decisions](idd-template/ONBOARDING.md#step-1b--confirm-policy-decisions)
と [helper runtime の選択順](docs/idd-helper-scripts.md#import-time-selection-order)
を併せて確認してください。

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

## ローカル pnpm ツール基盤（このリポジトリのコントリビューター専用）

このリポジトリには project-local の pnpm 基盤と Husky hook を追加し、
コミット前に最小 lint ゲートをローカルでも強制できるようにしました。
**このセクションは、このソースリポジトリで dogfooding する場合専用です。**
テンプレートの採用者は pnpm を必要としません — プロジェクト既存のツールを使い、
validate コマンドを適切に設定してください。採用者向けのガイダンスは
[Tooling boundary](docs/customization.md#tooling-boundary) を参照してください。

Node.js `^22.22.2 || >=24.2.0`（このリポジトリの `package.json` が定める
`engines` の下限）が必要です。

```sh
corepack enable
pnpm install
pnpm run lint
pnpm run test
```

pre-commit hook は高速・コミット安全なサブセット
(`pnpm run lint:precommit`: Biome・dprint・markdownlint)を実行し、完全な
`pnpm run lint:minimum` スイートは CI で実行されます。commit-msg hook は
commitlint により Conventional Commits を検証します。

`idd-template/` 配下の正規ソースファイルを編集したときは、`pnpm run docs:sync`
を実行して、すべてのミラーアーティファクトに変更を伝播してください。

## IDD が自動化すること

IDD は、良い意味で退屈なワークフローです。各フェーズには名前付きの役割、
再開できるマーカー、次の手順があります。

| ステージ    | エージェントが行うこと                                                                     |
| ----------- | ------------------------------------------------------------------------------------------ |
| Discover    | ロードマップまたは単独 issue から着手できる作業を探し、範囲を勝手に広げません。            |
| Claim       | 機械可読な担当マーカーで 1 つの issue を予約します。                                       |
| Work        | ブランチと worktree を作り、計画、実装、セルフレビューを行います。                         |
| Submit PR   | push して PR を開き、レビューできる状態になるまで検証を待ちます。                          |
| Review Loop | レビューの動きを記録し、指摘を採用または見送り、採用した指摘を直します。                   |
| Merge       | 最新状態、助言レビュー、CI、未解決スレッド、コメント、選択したマージポリシーを確認します。 |
| Cleanup     | マージ完了後、安全な場合は古いマーカーを隠して、次の Discover へ戻ります。                 |

完全なフェーズ一覧は [docs/idd-workflow.md](docs/idd-workflow.md) と
`.github/instructions/` にあります。

## 得られるもの

- **衝突しにくい並列作業** — 担当宣言と heartbeat マーカーによって、中央の
  調整役がいなくても issue の担当者が見えるようになります。
- **止まりにくい PR** — 最初の PR を開いた後も、レビューコメント、CI、追加修正を
  追い続けます。
- **ブラックボックスではない移植可能なルール** — ワークフローは導入先の
  リポジトリにそのまま読める Markdown として残るため、フォークも
  カスタマイズも簡単です。
- **エージェントを選べる自由** — 中核のループは GitHub Copilot、Claude Code、
  OpenAI Codex CLI、OpenCode、Antigravity CLI (formerly Gemini CLI) で
  動作します。配布時点の標準 PR ポリシーには Copilot の助言レビューが
  含まれますが、別のゲートを使う導入先向けに PR レビューポリシーの
  プロファイルも文書化しています。
- **運用するサービスが不要** — テンプレートファイルを取り込むだけで始められます。
  別のサーバー、スケジューラ、SaaS アカウントは不要です。

より詳しい位置づけは
[docs/positioning.md](docs/positioning.md) を参照してください。

## このリポジトリが配布するもの

主なパッケージは [`idd-template/`](idd-template/) です。導入先のリポジトリに
コピーする、移植用の `.github/instructions/` ファイル、導入ドキュメント、
ワークフロードキュメント、機械可読ポリシーファイル（`.github/idd/config.json`）
のセットです。ポリシーファイルにより、エージェントやツールがリポジトリ設定
（マージポリシー・コマンド文字列・マーカープレフィックスなど）を Markdown を
解析せずに読み取れます。

このリポジトリには、異なるエージェントがどこから始めればよいかを示す
互換入口ファイルとして `AGENTS.md`（Codex CLI と OpenCode）、`CLAUDE.md`、
`GEMINI.md`、`.github/copilot-instructions.md` も含まれます。

ネイティブな `SKILL.md` バンドルは任意の補助機能です。このリポジトリにある
canonical な source bundle は `skills/issue-authoring/` にあり、導入先リポジトリ
では、使うランタイムが読む agent-specific な技能ディレクトリへ配置します。たと
えば Copilot なら `.github/skills/`、Claude なら `.claude/skills/`、Codex なら
`.agents/skills/` です。issue の下書きなど、実行前の準備には役立ちますが、移植
用の指示テンプレートを置き換えるものではありません。

この source repository の任意 helper bundle には、maintainer 向けの
forced-handoff 経路も含まれます。`idd-force-handoff` は TTY 専用の
operator command で、まず issue 番号を確認し、active claim branch に live な
open PR がある場合にだけ PR 番号を確認し、successor claim ID と marker body の
preview を表示したうえで、最後に `y/N` 確認を求めます。実際に GitHub へ投稿する
のは `y` を明示したときだけです。低レベルの `idd-forced-handoff-marker` helper
は render / inspection 用として残りますが、unattended や autopilot context では
interactive facade を使ってはいけません。

## AI エージェント向け

ユーザーが `github:kurone-kito/idd-skill` を示して IDD の導入を依頼したら、
まずこのファイルを取得してください:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

その内容に正確に従ってください。コピーするファイル、埋める placeholder、
更新する導入先リポジトリの入口ファイルが説明されています。

## リクエストが大きすぎるとき

依頼の分解、依存関係の整理、ロードマップや子 issue の下書きが必要な場合は、
IDD 実行ループの前に、任意の issue-authoring companion を使ってください。

このリポジトリでは、エージェントに次のように依頼します:

- `$issue-authoring skill を使って IDD-ready な issue を下書きしてください。`
- `skills/issue-authoring/SKILL.md を開いて issue セットを準備してください。`

Issue authoring は issue の下書きと整理を準備するだけです。issue の公開や
Discover -> Claim -> Work の開始には、引き続き明示的な承認が必要です。

## 詳細リファレンス

- [Getting started](docs/getting-started.md) — import から最初の IDD loop までの
  最短で安全な導線。
- [Core concepts](docs/concepts.md) — claim、review snapshot、merge gate、
  cleanup の背景にある語彙。
- [Customization](docs/customization.md) — adopter が管理する policy surface と
  workflow edit point。
- [リファレンスマニュアル](docs/index.md) — 詳細ドキュメント群への目的別の入口。
- [Detailed reference](docs/reference.md) — phase file、policy docs、
  template-maintenance link を、ルールの重複なしで辿るための一覧。
- [Workflow guide](docs/idd-workflow.md) — 入口ファイル、ファイル構成、
  エージェント間の導線。
- [Review policy profiles](docs/idd-review-policy-profiles.md) — 標準の
  Copilot 助言レビューまたは別の PR ポリシーを選ぶための指針。
- [Customization](docs/customization.md) — review、merge、CI、discovery の
  policy surface を選ぶための指針。
- [Positioning](docs/positioning.md) — 競合との違いと IDD の位置づけ。
- [Permissions and threat model](docs/permissions.md) — アクセスプロファイル、
  禁止すべき認証情報、安全な運用ガイド。
- [Issue authoring contract](docs/issue-authoring-skill.md) — 任意で使える、
  実行前の issue 下書きモデル。
- [Comment minimization](docs/idd-comment-minimization.md) — マージ後の
  comment minimization ポリシー。
- [Template import guide](idd-template/ONBOARDING.md) — 導入先リポジトリ向けの
  生の導入手順。

## ライセンス

[MIT](./LICENSE)
