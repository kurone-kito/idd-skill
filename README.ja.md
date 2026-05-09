# IDD Skill — Issue-Driven Development ワークフロー

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: [English](./README.md) | **日本語**

複数の AI エージェントが GitHub Issues から並行して作業しても、
互いの作業にぶつからず進められるようにします。

IDD Skill は、リポジトリへ移植できる Issue-Driven Development
ワークフローです。エージェントは着手できる issue を探し、担当を宣言し、
ブランチを切って実装し、PR を開き、レビュー指摘を反映し、CI を待ち、
マージして後片づけまで進めます。ループ全体は、リポジトリ内の Markdown
の指示ファイルとして管理されます。

最初の PR を開いたところで AI エージェントが止まるのではなく、その後の
引き継ぎまで進み続けてほしいチームに向いています。

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
実装、PR レビュー、CI、マージ、後片づけまでループを進めます。

ループを最後まで実行するには、エージェントが `git`、認証済みの `gh` CLI
または同等の GitHub MCP 連携、`jq`、`npx` を使える Node.js/npm、
そして運用マーカーを確実に投稿するための `curl` などの REST client に
アクセスできる必要があります。必要なコマンドの詳細はワークフロードキュメントを
参照してください。

## IDD が自動化すること

IDD は、良い意味で退屈なワークフローです。各フェーズには名前付きの役割、
再開できるマーカー、次の手順があります。

| ステージ    | エージェントが行うこと                                                                  |
| ----------- | --------------------------------------------------------------------------------------- |
| Discover    | ロードマップまたは単独 issue から着手できる作業を探し、範囲を勝手に広げません。         |
| Claim       | 機械可読な担当マーカーで 1 つの issue を予約します。                                    |
| Work        | ブランチと worktree を作り、計画、実装、セルフレビューを行います。                      |
| Submit PR   | push して PR を開き、レビューできる状態になるまで検証を待ちます。                       |
| Review Loop | レビューの動きを記録し、指摘を採用または見送り、採用した指摘を直します。                |
| Merge       | 最新状態、助言レビュー、CI、未解決スレッド、コメントをもう一度確認します。              |
| Cleanup     | 検証済み HEAD をマージし、安全な場合は古いマーカーを隠して、次の discovery へ戻ります。 |

完全なフェーズ一覧は [docs/idd-workflow.md](docs/idd-workflow.md) と
`.github/instructions/` にあります。

## 得られるもの

- **衝突しにくい並列作業** — 担当宣言と heartbeat マーカーによって、中央の
  調整役がいなくても issue の担当者が見えるようになります。
- **止まりにくい PR** — 最初の pull request を開いた後も、レビューコメント、CI、
  追加修正を追い続けます。
- **ブラックボックスではない移植可能なルール** — ワークフローは導入先の
  リポジトリにそのまま読める Markdown として残るため、フォークも
  カスタマイズも簡単です。
- **エージェントを選べる自由** — 中核のループは GitHub Copilot、Claude Code、
  OpenAI Codex CLI、Gemini CLI で動作します。配布時点の標準 PR ポリシーには
  Copilot の助言レビューが含まれます。
- **運用するサービスが不要** — テンプレートファイルを取り込むだけで始められます。
  別のサーバー、スケジューラ、SaaS アカウントは不要です。

より詳しい位置づけは
[docs/positioning.md](docs/positioning.md) を参照してください。

## このリポジトリが配布するもの

主な package は [`idd-template/`](idd-template/) です。導入先の repository に
コピーする、移植用の `.github/instructions/` files、導入 docs、workflow docs の
セットです。

この repository には、異なるエージェントがここでどこから始めればよいかを示す
互換 entry files として `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、
`.github/copilot-instructions.md` も含まれます。

Native `SKILL.md` bundle は任意の補助機能です。issue の下書きなど、実行前の
準備には役立ちますが、移植用 instruction template を置き換えるものではありません。

## AI エージェント向け

ユーザーが `github:kurone-kito/idd-skill` を示して IDD onboarding を依頼したら、
まずこのファイルを取得してください:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

その内容に正確に従ってください。コピーするファイル、埋める placeholders、
更新する導入先リポジトリの entry files が説明されています。

## リクエストが大きすぎるとき

依頼の分解、依存関係の整理、ロードマップや子 issue の下書きが必要な場合は、
IDD execution loop の前に任意の issue-authoring companion を使ってください。

このリポジトリでは、エージェントに次のように依頼します:

- `$issue-authoring skill を使って IDD-ready な issue を draft してください。`
- `skills/issue-authoring/SKILL.md を開いて issue set を準備してください。`

Issue authoring は issue の下書きと整理を準備するだけです。issue の公開や
Discover -> Claim -> Work の開始には、引き続き明示的な承認が必要です。

## 詳細リファレンス

- [リファレンスマニュアル](docs/index.md) — 詳細ドキュメント群への目的別の入口。
- [Workflow guide](docs/idd-workflow.md) — 入口ファイル、file map、
  cross-agent routing。
- [Positioning](docs/positioning.md) — 競合との違いと IDD の位置づけ。
- [Issue authoring contract](docs/issue-authoring-skill.md) — 任意で使える、
  実行前の issue 下書きモデル。
- [Comment minimization](docs/idd-comment-minimization.md) — post-merge cleanup
  policy。
- [Template import guide](idd-template/ONBOARDING.md) — target repository
  向けの raw onboarding instructions。

## ライセンス

[MIT](./LICENSE)
