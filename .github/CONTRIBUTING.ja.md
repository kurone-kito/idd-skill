# プロジェクトへの貢献

Language: [🇬🇧](./CONTRIBUTING.md) | **🇯🇵** | [🇨🇳](./CONTRIBUTING.zh.md)

---

1. [行動規範](./CODE_OF_CONDUCT.ja.md)がありますので、
   プロジェクトとのやり取りのすべてに従ってください。
2. このリポジトリに貢献する際には、変更を加える前に、このリポジトリの所有者と
   [Discussions](https://github.com/kurone-kito/idd-skill/discussions)
   やその他の方法で変更したいことについて最初に話し合ってください。
3. もしあなたのアイデアが**小さな修正で示せるのなら、
   [Pull request](https://github.com/kurone-kito/idd-skill/pulls)
   を直接活用**してください。
4. このリポジトリでは、できる限り
   **[英語、または日本語](https://translate.google.com/)
   での議論**を推奨しています。
5. このプロジェクトは
   [Conventional Commits](https://www.conventionalcommits.org/)
   に準拠しています。表題はユーザー目線で記述し、本文では、
   なぜこの変更が必要か・どのような背景や文脈があるか・どのような変更を行ったかが
   分かるように自然な文章で説明してください（いわゆる *Why* / *Context* / *Change* を
   含めてください）。リポジトリルートに `.gitmessage` テンプレートがあります。詳細は
   [copilot-instructions.md](./copilot-instructions.md#commit-rules)
   を参照してください。

## ローカル開発ツール

このリポジトリには project-local の pnpm 基盤と Husky hook があり、
コントリビューターと autopilot 実行がコミット前に最小 lint ゲートを
強制できます。テンプレートの採用者は pnpm を必要としません —
プロジェクト既存のツールを使ってください(詳細は
[Tooling boundary](../docs/customization.md#tooling-boundary))。

Node.js `^22.23.2 || ^24.2.0 || >=26.0.0`(このリポジトリの `package.json` が
定める `engines` の下限)が必要です。

```sh
corepack enable
pnpm install
pnpm run setup:hooks # Git hook を有効にする。clone ごと・新しい worktree ごとに 1 回実行
pnpm run check # 完全な検証スイート。プルリクエストを開く前に実行
```

Node.js 25 以降は corepack を同梱しません。`corepack enable` が
失敗する場合は、先に `npm install -g corepack` でインストールしてください。

pre-commit hook は高速・コミット安全なサブセット
(`pnpm run lint:precommit`: Biome・dprint・markdownlint)を実行し、
完全な `pnpm run check` スイートは CI で実行されます(`pnpm run lint:minimum`
は互換エイリアスです)。

`pnpm run check` は lint・typecheck・ビルド成果物・テスト・監査の各段階を
実行します。必要な段階だけを実行する場合は `pnpm run lint`(Biome・dprint・
cspell・markdownlint・ソースの検査)、`pnpm run typecheck`、`pnpm run test`、
`pnpm run audit`、`pnpm run build:check`(生成物を書き換えずに検証)を
使ってください。`pnpm run lint:fix` は整形と lint の修正を明示的に適用します。
`pnpm run doctor:github` はオンラインの GitHub 診断で、`check` とは別に、
GitHub へのアクセスが必要です。一部だけを実行した場合は、プルリクエストに
実行したサブセットを記載してください。
commit-msg hook は commitlint により Conventional Commits を検証します。

`idd-template/` 配下の正規ソースファイルを編集したときは、
`pnpm run docs:sync` を実行して、すべてのミラーアーティファクトへ
変更を伝播してください。
