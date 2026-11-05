# My Website

個人用Webサイトの制作・管理用リポジトリです。
HTML/PHPによる複数ページ構成と、TypeScriptによる安全かつ効率的なフロントエンド開発環境を構築しています。

---

## 📁 ディレクトリ構造 (Directory Structure)

```text
my-website/
├── index.php             # トップページ
├── about/                # プロフィール・概要ページ
│   └── index.php
├── contact/              # お問い合わせページ
│   └── index.php
├── includes/             # PHP共通パーツ（ヘッダー・フッターなど）
│   ├── header.php
│   └── footer.php
├── css/                  # スタイルシート
│   └── style.css
├── js/                   # TypeScriptからコンパイル出力されたJavaScript
│   └── main.js
├── src/                  # 開発用ソースコード
│   └── ts/               # TypeScriptソースファイル
│       └── app.ts
├── images/               # 画像素材フォルダ
├── package.json          # Node.jsパッケージ管理
├── tsconfig.json         # TypeScriptコンパイル設定
└── README.md             # プロジェクト仕様書