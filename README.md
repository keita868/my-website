# 九州工業大学交響楽団 Webページ

九州工業大学交響楽団の公式Webサイトの制作・管理用リポジトリです。

- HTML/PHPによる複数ページ構成
- TypeScriptによるフロントエンド実装
- 次の世代の団員が編集しやすい管理者用ページの整備（予定）

---

## 🛠 技術スタック

| 分類 | 使用技術 |
| --- | --- |
| マークアップ / サーバーサイド | HTML, PHP |
| フロントエンド | TypeScript → JavaScript（コンパイル出力） |
| スタイル | CSS |
| パッケージ管理 | Node.js (npm) |

---

## 📁 ディレクトリ構造

```text
kyutech-orchestra-web/
├── index.php             # トップページ
├── about/                # 楽団概要ページ
│   └── index.php
├── contact/              # お問い合わせページ
│   └── index.php
├── includes/             # PHP共通パーツ
│   ├── header.php
│   └── footer.php
├── css/                  # スタイルシート
│   └── style.css
├── js/                   # TypeScriptのコンパイル出力（直接編集禁止）
│   └── main.js
├── src/                  # 開発用ソースコード
│   └── ts/
│       └── app.ts        # TypeScriptソース
├── images/               # 画像素材
├── package.json          # Node.jsパッケージ管理
├── tsconfig.json         # TypeScriptコンパイル設定
└── README.md             # このファイル

現在はabout/contactしか作ってないが、将来的には増やすつもり。
ファイル自体は名前変わる可能性あり。
```

---

## 🚀 セットアップ

```bash
# リポジトリを取得（SSH）
git clone git@github.com:keita868/my-website.git
cd my-website

# 依存パッケージのインストール
npm install

# TypeScriptのコンパイル（js/main.js が生成されます）
npx tsc

```

---

## 👥 開発ガイドライン

本リポジトリで作業するメンバーは、以下のルールに従ってください。

### 1. 日常ワークフロー

| 手順 | 操作 | 内容 |
| --- | --- | --- |
| 1. 準備 | `git checkout main`<br>`git pull origin main` | 作業前に最新の `main` を取り込む |
| 2. 分岐 | `git checkout -b feature/機能名` | 作業用ブランチを作成する |
| 3. 開発 | （コードの編集・ビルド） | ローカルで実装と動作確認を行う |
| 4. 記録 | `git add .`<br>`git commit -m "種別: 変更内容"` | 適切な粒度でコミットする |
| 5. 送信 | `git push origin feature/機能名` | 作業ブランチをGitHubへプッシュする |
| 6. 申請 | `Compare & pull request`（GitHub上） | プルリクエストを作成してレビューを依頼する |
| 7. 統合 | `Merge pull request`（GitHub上） | 問題がなければ `main` にマージする |
| 8. 同期 | `git checkout main`<br>`git pull origin main` | ローカルの `main` を最新に戻す |

### 2. コミットメッセージの規則

メッセージは `種別: 変更内容` の形式で書きます。

| 種別 | 用途 | 例 |
| --- | --- | --- |
| `feat:` | 新機能の追加 | `feat: お問い合わせフォームのバリデーション追加` |
| `fix:` | バグ・表示崩れの修正 | `fix: スマホ表示時のヘッダー崩れを修正` |
| `docs:` | ドキュメントの更新 | `docs: READMEに運用ルールを追記` |
| `style:` | 見た目の調整（コードの意味に影響なし） | `style: インデントの整理と不要なログ削除` |
| `refactor:` | リファクタリング | `refactor: PHP共通パーツの読み込み処理を最適化` |

### 3. 禁止事項・注意事項

| やってはいけないこと | リスク | 対策 |
| --- | --- | --- |
| `main` への直接push | テスト未完了コードの混入、他メンバーの作業破壊 | 必ず `feature/` ブランチを切り、PR経由でマージする |
| 強制プッシュ（`git push -f`） | 他メンバーのコミット履歴や作業を破壊する | 絶対に使用しない |
| 機密情報のコミット | APIキーやパスワードが外部に漏洩する | `.gitignore` で確実に除外する |
| ビルド生成物の直接編集 | `js/main.js` 等はコンパイル時に上書きされて消える | 必ず `src/ts/` 側のソースを修正する |
| 未コミットでのブランチ移動 | コンフリクトや作業内容の消失につながる | こまめにコミットするか `git stash` を活用する |

---

## 📝 次の世代の方へ

このサイトは、毎年メンバーが入れ替わる中でも更新を続けられることを目指しています。

- 内容を更新するときは、まず上のワークフローに沿ってブランチを切ってください
- 管理者用ページのパスワードはなるべく1年に1回は更新するようにお願いします。
- 困ったときは先輩や過去のPR・コミット履歴を見ると、変更の経緯がわかります