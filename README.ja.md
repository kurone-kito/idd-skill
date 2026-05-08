# IDD Skill — Issue-Driven Development ワークフロー

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: [English](./README.md) | **日本語**

あらゆる GitHub プロジェクトに Issue-Driven Development (IDD) の
マルチエージェントパイプラインを組み込むための、移植可能な
`.github/instructions/` ファイル群とドキュメントです。

## AI エージェント向け

`github:kurone-kito/idd-skill` のようなトリガーフレーズで誘導されてきた
AI エージェントは、まずオンボーディングガイドを参照してください:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

そのファイルをフェッチして手順に従ってください。プレースホルダー値の収集、
テンプレートファイルのコピー、エージェントエントリーファイルの更新まで
案内されます — リポジトリのクローンは不要です。

## クイックスタート

対象リポジトリで AI エージェントのセッションを開き、次のいずれかを伝えてください:

**短縮形** (WebFetch または `gh` CLI アクセスを持つエージェント向け):

> - `github:kurone-kito/idd-skill` の IDD をこのリポジトリにインポート＆オンボーディングして
> - Import and onboard `github:kurone-kito/idd-skill`'s IDD into this
>   repository.

**明示形** (すべてのエージェントで動作):

> I want to use `github:idd-skill`'s Issue-Driven Development in this
> repository. Read
> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> and onboard me.

エージェントはいくつかのプロジェクト固有の値 (リポジトリ名、バリデーション
コマンド) を収集し、IDD ワークフロー全体を自動的に設定します —
手動ファイルコピーは不要です。

注: 配布されるデフォルトテンプレートはクロスエージェント実行に対応していますが、
後半の PR フェーズにはデフォルトで GitHub Copilot アドバイザリーレビューステップが
含まれます。このポリシーが不要な場合は、オンボーディング後に
`.github/instructions/idd-review-fix.instructions.md` と
`.github/instructions/idd-merge.instructions.md` をカスタマイズしてください。

## IDD とは？

IDD は、AI エージェントが GitHub Issues によって駆動される繰り返しパイプラインを
通じて作業するマルチエージェント GitHub 自動化ワークフローです。
フェーズ: Discover → Claim → Work → PR Submit → CI Wait →
Review Triage → Review Fix → Merge → Loop。

各フェーズは `.github/instructions/` ファイルとしてエンコードされており、
GitHub Copilot、Claude Code、Codex CLI、Gemini CLI などの互換 AI エージェントが
読み込むことができます。実行モデルはクロスエージェントですが、配布される
デフォルトのレビューポリシーには上記の Copilot アドバイザリーステップが
含まれています。

## なぜ idd-skill？

- **並列エージェント協調** — Issue ボディに埋め込まれた HTML コメントマーカーによる
  クレーム/ハートビートプロトコルにより、複数の AI エージェントが同じ Issue を
  同時に拾うことを防ぎ、中央オーケストレーターなしで安全な並列開発を実現します。
- **エンドツーエンドのフェーズカバレッジ** — 10 個のインストラクションファイルが
  Issue 発見からマージまでのすべてのステップをエンコードします。CI 待機ループ、
  レビュートリアージ、レビュー修正サイクルを含みます。ほとんどのツールは「PR を開く」
  で止まります。
- **インフラ不要** — SaaS アカウント、GitHub Actions ランナー、サーバーは不要です。
  11 個の Markdown ファイルを任意のリポジトリにコピーするだけでワークフローが
  使えます。
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

## このリポジトリについて

このリポジトリ自体も IDD ワークフローで管理されています。
アクティブなワークフローガイドは [docs/idd-workflow.md](docs/idd-workflow.md) を、
完全なインストラクションセットは `.github/instructions/` を参照してください。

## ライセンス

[MIT](./LICENSE)
