# IDD Skill — Issue-Driven Development ワークフロー

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: [English](./README.md) | **日本語**

あらゆる GitHub プロジェクトに Issue-Driven Development (IDD) の
マルチエージェントパイプラインを組み込むための、移植可能な
`.github/instructions/` ファイル群とドキュメントです。

## IDD とは？

IDD は、AI エージェントが GitHub Issues によって駆動される繰り返しパイプラインを
通じて作業するマルチエージェント GitHub 自動化ワークフローです。
フェーズ: Discover → Claim → Work → PR Submit → CI Wait →
Review Triage → Review Fix → Merge → Loop。

各フェーズは `.github/instructions/` ファイルとしてエンコードされており、
GitHub Copilot、Claude Code、Codex CLI、Gemini CLI などの互換 AI エージェントが
読み込めます。実行モデルはクロスエージェントですが、配布される
デフォルトのレビューポリシーには下記の Copilot アドバイザリーステップが
含まれています。

## はじめに

IDD は、次の 2 つの手順を分けて使います:

1. 対象リポジトリへ
   [IDD をインストール / オンボーディング](#idd-のインストール--オンボーディング)
   する。
2. 対象リポジトリの準備ができてから
   [オンボーディング後に IDD を実行する](#オンボーディング後に-idd-を実行する)。

AI エージェントとして raw onboarding entry point だけが必要な場合は、
[AI エージェント向け](#ai-エージェント向け) を参照してください。

## 実行前提

IDD ループをエンドツーエンドで実行するには、いくつかのローカルツールと
GitHub アクセス手段が必要です:

- branch、worktree、fetch、rebase、merge、status、commit 操作のための
  `git`。
- 認証済みの `gh` CLI、または同等の GH MCP integration による GitHub issue、
  pull request、review、checks、comments、branch protection/ruleset、merge への
  アクセス。ドキュメント内の shell snippet は `gh` を使います。
- ページネーションされた GitHub API レスポンスを処理するドキュメント内の
  shell snippet で使う `jq`。
- このリポジトリの validation command が現在使っている `dprint`、
  `markdownlint-cli2`、`cspell` を `npx` で実行するための Node.js/npm。
- HTML コメントで始まる operational marker を投稿するときに、
  `gh issue comment` より信頼できる経路が必要な場合に使う `curl` または同等の
  REST client。

WorkTrunk、`git-wt`、commit signing alias などの任意ヘルパーはループを
スムーズにできますが、基本要件ではありません。

## IDD のインストール / オンボーディング

対象リポジトリで AI エージェントのセッションを開き、次のいずれかを伝えてください:

**短縮形** (WebFetch または `gh` CLI アクセスを持つエージェント向け):

> `github:kurone-kito/idd-skill` の IDD をこのリポジトリに
> インポート＆オンボーディングして

**明示形** (すべてのエージェントで動作):

> `github:idd-skill` の Issue-Driven Development をこの
> リポジトリで使いたいです。`https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> を読んでオンボーディングしてください。

エージェントはいくつかのプロジェクト固有の値 (リポジトリ名、バリデーション
コマンド) を収集し、IDD ワークフロー全体を自動的に設定します —
手動ファイルコピーは不要です。

注: 配布されるデフォルトテンプレートはクロスエージェント実行に対応していますが、
後半の PR フェーズにはデフォルトで GitHub Copilot アドバイザリーレビューステップが
含まれます。このポリシーが不要な場合は、オンボーディング後に
`.github/instructions/idd-review-fix.instructions.md` と
`.github/instructions/idd-merge.instructions.md` をカスタマイズしてください。

## AI エージェント向け

`github:kurone-kito/idd-skill` のようなトリガーフレーズで誘導されてきた
AI エージェントは、まずオンボーディングガイドを参照してください:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

そのファイルをフェッチして手順に従ってください。プレースホルダー値の収集、
テンプレートファイルのコピー、エージェントエントリーファイルの更新まで
案内されます — リポジトリのクローンは不要です。

## オンボーディング後に IDD を実行する

オンボーディングが終わったら、対象リポジトリで AI エージェントのセッションを開き、
ワークフローの開始を依頼してください。エージェントはまず
[docs/idd-workflow.md](docs/idd-workflow.md) を読み、次に
`.github/instructions/idd-overview.instructions.md` を開いてから、
Discover → Claim → Work → ... のループに入ります。

**フレーズ例**:

- `このリポジトリで IDD ワークフローを開始してください。`
- `docs/idd-workflow.md` を読んで、次に
  `.github/instructions/idd-overview.instructions.md` を開き、
  Discover → Claim → Work のループを開始してください。

## なぜ idd-skill？

- **並列エージェント協調** — Issue ボディに埋め込まれた HTML コメントマーカーによる
  クレーム/ハートビートプロトコルにより、複数の AI エージェントが同じ Issue を
  同時に拾うことを防ぎ、中央オーケストレーターなしで安全な並列開発を実現します。
- **エンドツーエンドのフェーズカバレッジ** — インストラクションセットが
  Issue 発見からマージまでのすべてのステップをエンコードします。CI 待機ループ、
  レビュートリアージ、レビュー修正サイクルを含みます。ほとんどのツールは「PR を開く」
  で止まります。
- **インフラ不要** — SaaS アカウント、GitHub Actions ランナー、サーバーは不要です。
  `idd-template/` のドキュメントとインストラクションファイルを任意のリポジトリに
  コピーするだけでワークフローが使えます。
- **エージェント非依存** — コアフェーズは GitHub Copilot、Claude Code、
  OpenAI Codex CLI、Gemini CLI でインストラクションを書き直すことなく動作します。
  (デフォルトテンプレートには後半フェーズに Copilot アドバイザリーレビューステップが
  含まれます。詳細は [docs/positioning.md](docs/positioning.md) を参照。)
- **完全監査可能** — すべてのルールはプレーン Markdown です。読んで、フォークして、
  適応させてください。ブラックボックスはありません。

詳細な競合状況と戦略的ポジショニング分析については
[docs/positioning.md](docs/positioning.md) を参照してください。

## IDD の手動インポート

1. このリポジトリをクローンまたはダウンロードします。
2. `idd-template/` ディレクトリの内容を対象リポジトリにコピーします。
3. `idd-template/ONBOARDING.md` に従ってプレースホルダーを埋め、
   エージェントエントリーファイルを更新します。

## アーティファクトモデル

このリポジトリが主に配布しているのは IDD のインストラクションテンプレートであり、
単一のエージェントネイティブ skill ではありません。`idd-template/` のエクスポート
パッケージには、導入先リポジトリへコピーする移植可能な `.github/instructions/`
ファイル、オンボーディングドキュメント、ワークフロードキュメントが含まれます。

`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、
`.github/copilot-instructions.md` などのエージェントエントリーファイルは、
このリポジトリ向けの互換入口です。ネイティブ `SKILL.md` バンドルが存在する場合、
それらは IDD ドキュメントを参照できる補助機能ですが、インストラクションテンプレート
そのものを置き換えるものではありません。

## このリポジトリについて

このリポジトリ自体も IDD ワークフローで管理されています。
アクティブなワークフローガイドは [docs/idd-workflow.md](docs/idd-workflow.md) を、
完全なインストラクションセットは `.github/instructions/` を参照してください。

あわせて、repo ローカルのネイティブ skill bundle
`skills/issue-authoring/` も含まれています。実行前に IDD-ready な
issue や roadmap をドラフト・分解したいときはその bundle を使い、
issue セットの承認後に通常の実行ループへ入るときは
[docs/idd-workflow.md](docs/idd-workflow.md) と
`.github/instructions/` を使ってください。

## ライセンス

[MIT](./LICENSE)
