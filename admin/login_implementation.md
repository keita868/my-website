# 管理者ログイン機能の実装内容

更新日：2026-11-09

## 概要

[CMS構成案](./cms_structure_plan.md)に沿って、管理画面への管理者ログイン、サーバー側セッションによる認証、ログアウトの基盤を追加しました。管理者アカウントは公開登録ではなく、コマンドから作成します。

## 追加・変更したファイル

| ファイル | 内容 |
| --- | --- |
| `backend/package.json` | Express、SQLite、セッション、Argon2idなどバックエンドの依存関係と起動コマンド |
| `backend/src/server.js` | 管理画面ルーティング、認証・管理者API、セッション、CSRF、試行回数制限 |
| `backend/src/database.js`、`backend/migrations/001_admin_management.sql` | SQLiteの初期化と既存データを保持する管理者スキーマの追加 |
| `backend/src/create-admin.js` | 初期管理者を対話形式で作成するコマンド。最初の管理者は`superadmin` |
| `backend/test/admin-auth.test.js` | 既存DB移行、認証、権限、アカウント管理、パスワード変更の統合テスト |
| `admin/dashboard/login.html` | 管理者ログイン画面 |
| `admin/dashboard/index.html`、`admin/dashboard/admins.html`、`admin/dashboard/account.html` | ダッシュボード、管理者管理、アカウント設定 |
| `admin/dashboard/assets/login.js` | CSRFトークン取得とログインフォーム処理 |
| `admin/dashboard/assets/dashboard.js`、`admin/dashboard/assets/admins.js`、`admin/dashboard/assets/account.js` | ログイン状態、管理者管理、アカウント設定、ログアウト処理 |
| `admin/dashboard/assets/dashboard.css` | ログイン画面・ダッシュボードのスタイル |
| `.gitignore` | 環境変数、SQLiteデータ、アップロード、依存パッケージをGit管理対象外に設定 |
| `README.md` | 管理画面のセットアップ手順 |

## ログインの仕組み

1. `/admin/login` でメールアドレスとパスワードを入力します。
2. ブラウザは `/api/auth/csrf` からCSRFトークンを取得し、ログイン要求に付けて送信します。
3. サーバーは管理者アカウントをSQLiteから検索し、Argon2idで保存したパスワードハッシュを照合します。
4. 認証成功時にセッションIDを再生成し、管理者IDをサーバー側セッションに保存します。
5. `/admin` と `/admin/dashboard` は有効な管理者セッションがある場合だけ表示されます。未認証の場合は `/admin/login` に戻ります。セッションは8時間操作がない場合に期限切れになります。
6. ログアウト時にセッションを破棄し、セッションCookieを削除します。

認証APIは次のとおりです。

| メソッド | URL | 用途 |
| --- | --- | --- |
| `GET` | `/api/auth/csrf` | CSRFトークンを取得 |
| `POST` | `/api/auth/login` | 管理者ログイン |
| `GET` | `/api/auth/me`、`GET /api/auth/session` | 現在のログイン管理者を取得。既存の`/session`も維持 |
| `PATCH` | `/api/auth/me` | 自分の表示名・メールアドレスを変更 |
| `POST` | `/api/auth/change-password` | 現在のパスワード確認後に変更し、全セッションを失効 |
| `POST` | `/api/auth/logout` | ログアウト |

管理者管理APIは`/api/admins`、`/api/admins/:id`で一覧・詳細・追加・情報変更・有効化/無効化を提供します。物理削除は提供しません。状態変更にはCSRFトークンとログインが必要で、管理者管理APIの操作権限は`superadmin`に限定されます。

## セキュリティ上の設定

- パスワードはArgon2idでハッシュ化し、作成時には入力を非表示にして確認入力も行います。長さは12〜1024文字です。メールアドレスの形式・重複、パスワード長、確認入力に誤りがあれば、修正して再入力できます。
- `superadmin`は管理者管理が可能です。`admin`は管理者一覧・管理操作にはアクセスできず、自分のプロフィールとパスワードのみ変更できます。最初に作成した管理者は`superadmin`になります。
- セッションはSQLiteに保存し、Cookieに`HttpOnly`と`SameSite=Strict`を設定します。`NODE_ENV=production`では`Secure`も有効になります。
- ログイン時にセッションIDを再生成し、8時間のアイドルタイムアウトを設けます。
- ログイン失敗を同一IPから15分間に10回までに制限します。成功したログインは回数に含めず、共有IPの利用者を過度に締め出さない設定です。
- 未登録・無効なメールアドレスと誤ったパスワードで同じログインエラーを返します。
- パスワード変更とアカウント無効化・再有効化時はセッションバージョンを更新し、既存セッションを利用不可にします。
- 自分自身の無効化、最後の有効な管理者の無効化、最後の有効な`superadmin`の無効化・降格はできません。
- ログインとログアウトの更新要求にCSRFトークンを要求します。
- APIと認証画面にはキャッシュ抑制を設定します。
- DBファイルとセッションファイルは`backend/data/`に保存し、Gitの追跡対象外とします。
- スキーマの追加は`backend/migrations/`で管理し、既存の`admins`レコードを削除・再作成しません。
- サーバー起動には32文字以上の`CMS_SESSION_SECRET`が必要です。本番運用ではHTTPSを使用し、秘密鍵を環境変数またはシークレット管理機能で安全に設定してください。

## 開発環境での起動

Node.js 22以降が必要です。リポジトリのルートから実行します。

```bash
# バックエンド依存パッケージをインストール
npm install --prefix backend

# セッション秘密鍵を設定（管理者作成・サーバー起動の両方で同じ値を使う）
export CMS_SESSION_SECRET="$(openssl rand -hex 32)"

# 管理者アカウントを作成（表示名・メールアドレス・パスワードを対話入力）
npm --prefix backend run admin:create

# 管理画面を起動
npm --prefix backend start
```

起動後、`http://localhost:3000/admin/login`を開いてログインします。秘密鍵を変更すると既存のセッションは利用できなくなるため、同じ値を継続して使ってください。

TLS終端プロキシ経由で運用する場合は、構成を確認したうえで`TRUST_PROXY=1`を設定します。

## 現在の範囲と確認状況

認証・管理の統合テストは`npm --prefix backend test`で実行できます。テストでは一時SQLite DBを使い、既存スキーマからの移行、ログイン、権限境界、管理者追加、パスワード変更後のセッション失効などを確認します。ログイン履歴、パスワードリセット、MFA、権限の細分化は未実装です。

管理者追加APIはパスワードハッシュ生成後にも、DBトランザクション内で操作者の有効状態・現在の`superadmin`権限・セッション版を再確認します。CSRFトークンはセッション内で再利用し、ログイン成功時のセッション再生成で更新します。
