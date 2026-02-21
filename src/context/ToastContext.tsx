import React, { createContext, useContext, useState } from "react";
import AppToast from "@components/AppToast";

type ToastVariant = "success" | "error" | "warning" | "info";

type ToastContextType = {
	show: (message: string, variant?: ToastVariant) => void;
};

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [message, setMessage] = useState("");
	const [variant, setVariant] = useState<ToastVariant>("info");
	const [visible, setVisible] = useState(false);

	const show = (msg: string, type: ToastVariant = "info") => {
		setMessage(msg);
		setVariant(type);
		setVisible(true);
	};

	return (
		<ToastContext.Provider value={{ show }}>
			{children}

			<AppToast
				message={message}
				variant={variant}
				visible={visible}
				onHide={() => setVisible(false)}
			/>
		</ToastContext.Provider>
	);
}

export function useToast() {
	const context = useContext(ToastContext);

	if (!context) {
		throw new Error("useToast must be used inside ToastProvider");
	}

	return context;
}
