import Link from "next/link";

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm bg-white p-6 rounded-xl shadow">
        <h1 className="text-xl font-bold text-center mb-2">
          まなぶ先生AI
        </h1>
        <p className="text-sm text-gray-600 text-center mb-6">
          学習分析サポート
        </p>

        <p className="text-center text-sm mb-4">
          ログイン方法を選択してください
        </p>

        <div className="space-y-4">
          <Link
            href="/login/parent"
            className="block w-full text-center bg-blue-600 text-white py-2 rounded-md hover:bg-blue-700"
          >
            保護者ログイン
          </Link>

          <p className="text-xs text-gray-500 text-center">
            ※ 塾の個人ページで使用している<br />
            生徒IDとパスワードでログインできます
          </p>

          <Link
            href="/login/teacher"
            className="block w-full text-center border py-2 rounded-md hover:bg-gray-100"
          >
            講師ログイン
          </Link>
        </div>

        <p className="text-xs text-gray-400 text-center mt-6">
          本サービスは、塾の学習支援を目的とした分析ツールです
        </p>
      </div>
    </div>
  );
}
