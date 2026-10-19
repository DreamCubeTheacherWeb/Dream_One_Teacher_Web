import { Link } from 'react-router-dom';
import { Home } from 'lucide-react';

export default function NotFound() {
    return (
        <div className="min-h-[60vh] flex items-center justify-center p-6">
            <div className="bh-card bg-white p-8 sm:p-10 max-w-md w-full text-center">
                <p className="text-5xl font-black text-bauhaus-blue mb-3">404</p>
                <h1 className="text-xl font-black text-bauhaus-black mb-2">找不到這個頁面</h1>
                <p className="text-bauhaus-black/60 font-medium mb-6">
                    網址可能打錯了，或這個頁面已經移動或移除。
                </p>
                <Link to="/" className="bh-btn bh-btn-blue px-6 py-3">
                    <Home className="w-4 h-4" /> 回首頁
                </Link>
            </div>
        </div>
    );
}
