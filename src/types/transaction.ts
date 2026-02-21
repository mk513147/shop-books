export type TransactionType = "income" | "expense";

export type PaymentType = "cash" | "online" | "due";

export const PAYMENT_OPTIONS = ["cash", "online", "due"] as const;
export interface TransactionInput {
	type: TransactionType;
	amount: number;
	category: string;
	note: string | null;
	date: string;
	paymentType: PaymentType;
	supplierId: number | null;
	imagePath: string | null;
}
