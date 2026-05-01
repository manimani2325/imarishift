# 🍶 ShiftMaster - デプロイ手順

URLを共有するだけで全員がリアルタイムでシフト管理できるWebアプリです。

---

## ステップ1：Firebaseのセットアップ（無料）

1. https://console.firebase.google.com を開く
2. 「プロジェクトを作成」→ 適当な名前をつける（例：shift-master）
3. Googleアナリティクスは「無効」でOK → 「プロジェクトを作成」
4. 左メニュー「構築」→「Realtime Database」→「データベースを作成」
5. ロケーション「asia-southeast1」→「テストモードで開始」→「有効にする」
6. 歯車⚙「プロジェクトの設定」→「全般」→「マイアプリ」→「</>」をクリック
7. アプリ名を入力 → 「アプリを登録」
8. 表示される firebaseConfig の中身をコピーしておく

---

## ステップ2：GitHubにアップロード

1. https://github.com でアカウント作成
2. 右上「+」→「New repository」→ 名前入力 → 「Create repository」
3. 「upload an existing file」→ このZIPを解凍したフォルダの中身を全部ドラッグ
4. 「Commit changes」をクリック

---

## ステップ3：Vercelにデプロイ

1. https://vercel.com → GitHubでログイン
2. 「New Project」→ リポジトリを選択 → 「Import」
3. 「Environment Variables」に以下7つを追加：

| 変数名 | 値 |
|--------|----|
| VITE_FIREBASE_API_KEY | apiKey |
| VITE_FIREBASE_AUTH_DOMAIN | authDomain |
| VITE_FIREBASE_DATABASE_URL | databaseURL |
| VITE_FIREBASE_PROJECT_ID | projectId |
| VITE_FIREBASE_STORAGE_BUCKET | storageBucket |
| VITE_FIREBASE_MESSAGING_SENDER_ID | messagingSenderId |
| VITE_FIREBASE_APP_ID | appId |

4. 「Deploy」→ 1〜2分でURL発行（例：shift-master.vercel.app）

---

## ステップ4：Firebaseルール設定

Firebase Console → Realtime Database → 「ルール」タブ → 以下に書き換えて「公開」：

```json
{
  "rules": {
    "shiftmaster": {
      ".read": true,
      ".write": true
    }
  }
}
```

---

## GMパスワード変更

src/App.jsx の下記を変更してGitHubに再アップ → 自動で再デプロイされます：

```js
const GM_PASSWORD='GM1234'
```

---

## 完成！

発行されたURLをLINEで全員に共有すれば完了です。
