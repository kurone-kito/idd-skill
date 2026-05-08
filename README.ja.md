# IDD Skill — イシュー駆動開発ワークフロー

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 言語: [English](./README.md) | **日本語**

GitHub プロジェクト向けに、Issue-Driven Development (IDD) の
マルチエージェントパイプラインを組み込むための
`.github/instructions/` 一式とドキュメントをまとめた配布用リポジトリです。

> このファイルは `README.md` の日本語版です。内容に差分が生じた場合は
> `README.md` を正とします。

## AI エージェント向け

`github:kurone-kito/idd-skill` のようなトリガーフレーズでここへ案内され、
IDD のオンボーディングを求められた場合は、まず次のガイドを開いてください。

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

このファイルを取得して手順に従ってください。プレースホルダー値の収集、
テンプレートファイルのコピー、リポジトリのエージェント entry file の更新まで、
クローン不要で進められます。

## クイックスタート

対象リポジトリでセッションを開き、AI エージェントに次のいずれかを伝えてください。

**短縮形**（WebFetch または `gh` CLI が使えるエージェント向け）:

> - `github:kurone-kito/idd-skill` の IDD をこのリポジトリにインポート＆オンボーディングして
> - Import and onboard `github:kurone-kito/idd-skill`'s IDD into this
>   repository.

**明示形**（どのエージェントでも利用可）:

> `github:idd-skill` の Issue-Driven Development をこのリポジトリで使いたいです。
> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> を読んでオンボーディングしてください。

エージェントは、repo 名や validation commands などのプロジェクト固有値を確認したうえで、
IDD ワークフロー全体を自動でセットアップします。手動でファイルをコピーする必要はありません。

注意: 配布テンプレートの実行モデル自体は cross-agent ですが、
後半の PR フェーズでは既定で GitHub Copilot の advisory review を利用します。
その PR ポリシーを使いたくない場合は、オンボーディング後に
`.github/instructions/idd-review-fix.instructions.md` と
`.github/instructions/idd-merge.instructions.md` を調整してください。

## IDD とは

IDD は、GitHub Issues だけを駆動源として AI エージェントが反復的に作業する、
マルチエージェント向けの GitHub 自動化ワークフローです。フェーズは
Discover → Claim → Work → PR Submit → CI Wait → Review Triage →
Review Fix → Merge → Loop です。

各フェーズは `.github/instructions/` 配下の instruction file として表現されており、
GitHub Copilot、Claude Code、Codex CLI、Gemini CLI などの互換エージェントが読めます。
この実行モデルは cross-agent ですが、既定の review policy には前述の
Copilot advisory step が含まれています。

## なぜ idd-skill なのか

- **並列エージェント調整** — issue body 内の HTML comment marker を使った
  claim/heartbeat protocol により、複数の AI エージェントが同じ issue を
  同時に取りに行うのを防ぎ、中央オーケストレータなしでも安全に並列開発できます。
- **エンドツーエンドのフェーズ網羅** — 10 個の instruction file が、
  issue discovery から merge までの全手順を表現します。CI wait loop、
  review triage、review-fix cycle まで含まれており、多くのツールのように
  「PR を開いて終わり」にはなりません。
- **インフラ不要** — SaaS アカウント、GitHub Actions runner、専用サーバは不要です。
  11 個の Markdown ファイルを任意のリポジトリへコピーすれば、ワークフローを使い始められます。
- **エージェント非依存** — コアフェーズは GitHub Copilot、Claude Code、
  OpenAI Codex CLI、Gemini CLI をまたいで利用できます。
  （既定テンプレートの後半フェーズには Copilot advisory review step があるため、
  詳細は [docs/positioning.md](docs/positioning.md) を参照してください。）
- **完全に監査可能** — すべてのルールが plain Markdown です。読めて、fork できて、
  そのまま適応できます。ブラックボックスはありません。

詳しい比較や戦略上の位置づけは
[docs/positioning.md](docs/positioning.md) を参照してください。

## IDD を手動で取り込む

1. このリポジトリを clone または download します。
2. `idd-template/` ディレクトリの内容を対象リポジトリへコピーします。
3. `idd-template/ONBOARDING.md` に従ってプレースホルダーを埋め、
   エージェント entry file を更新します。

## このリポジトリについて

このリポジトリ自身も IDD ワークフローで保守されています。現在の運用ガイドは
[docs/idd-workflow.md](docs/idd-workflow.md) を、完全な instruction set は
`.github/instructions/` を参照してください。

## ライセンス

[MIT](./LICENSE)
