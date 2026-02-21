import React, { useState, useEffect } from "react";
import {
	View,
	Text,
	TextInput,
	TouchableOpacity,
	Platform,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Picker } from "@react-native-picker/picker";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { theme } from "@theme";
import { incomeCategories } from "@constants/categories";

import {
	addTransaction,
	updateTransaction,
	getDailyTransactionCount,
	checkIncomeCategorySameDay,
} from "@database/transactionService";

import { RootStackParamList } from "@navigation/types";
import { styles } from "@screens/AddEntryScreen/AddEntry.styles";
import {
	PAYMENT_OPTIONS,
	PaymentType,
	TransactionInput,
} from "src/types/transaction";
import { useToast } from "@context/ToastContext";
type NavigationProp = NativeStackNavigationProp<RootStackParamList, "AddEntry">;

type Props = {
	editingTransaction: any;
	isEditMode: boolean;
	onSaveSuccess: () => void;
};

export default function IncomeForm({
	editingTransaction,
	isEditMode,
	onSaveSuccess,
}: Props) {
	const navigation = useNavigation<NavigationProp>();
	const { show } = useToast();
	const [amount, setAmount] = useState("");
	const [category, setCategory] = useState("");
	const [paymentType, setPaymentType] = useState<PaymentType>("cash");
	const [note, setNote] = useState("");
	const [selectedDate, setSelectedDate] = useState(new Date());
	const [showDatePicker, setShowDatePicker] = useState(false);

	const formatDate = (date: Date) => {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	useEffect(() => {
		if (editingTransaction?.type === "income") {
			setAmount(String(editingTransaction.amount));
			setCategory(editingTransaction.category ?? "");
			setPaymentType(editingTransaction.paymentType ?? "cash");
			setNote(editingTransaction.note ?? "");
			setSelectedDate(new Date(editingTransaction.date));
		}
	}, [editingTransaction]);

	const handleSave = async () => {
		try {
			if (!amount || !category) {
				show("Amount and Category are required", "info");
				return;
			}

			const numericAmount = Number(amount.trim());

			if (
				!Number.isFinite(numericAmount) ||
				numericAmount <= 0 ||
				numericAmount > 20000
			) {
				show("Enter a valid amount", "warning");
				return;
			}

			const formattedDate = formatDate(selectedDate);

			if (!isEditMode) {
				const count = await getDailyTransactionCount(formattedDate, "income");

				if (count >= 12) {
					show("Maximum 12 income entries allowed per day.", "warning");
					return;
				}
			}

			const existingCategory = await checkIncomeCategorySameDay(
				formattedDate,
				category,
				editingTransaction?.id,
			);

			if (existingCategory) {
				show(
					`Income category "${category}" already exists for this date.`,
					"warning",
				);
				return;
			}

			const payload: TransactionInput = {
				type: "income",
				amount: numericAmount,
				category,
				note: note || null,
				date: formattedDate,
				paymentType,
				supplierId: null,
				imagePath: null,
			};

			if (isEditMode) {
				await updateTransaction(editingTransaction.id, payload);
				onSaveSuccess();
				show("Transaction Updated", "success");
				navigation.goBack();
			} else {
				await addTransaction(payload);
				show("Transaction Saved", "success");

				setAmount("");
				setCategory("");
				setNote("");
				setPaymentType("cash");
				onSaveSuccess();
			}
		} catch (error) {
			console.log(error);
			show("Error saving transaction", "error");
		}
	};

	return (
		<>
			{/* DATE */}
			<Text style={styles.label}>Date</Text>
			<TouchableOpacity
				style={styles.input}
				onPress={() => setShowDatePicker(true)}
			>
				<Text>{formatDate(selectedDate)}</Text>
			</TouchableOpacity>

			{showDatePicker && (
				<DateTimePicker
					value={selectedDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(event, date) => {
						setShowDatePicker(false);
						if (date) setSelectedDate(date);
					}}
				/>
			)}

			{/* AMOUNT */}
			<Text style={styles.label}>Amount</Text>
			<TextInput
				style={styles.amountInput}
				keyboardType="numeric"
				placeholder="₹ 0.00"
				value={amount}
				onChangeText={setAmount}
				placeholderTextColor={theme.colors.textSecondary}
			/>

			{/* CATEGORY */}
			<Text style={styles.label}>Category</Text>
			<View style={styles.pickerWrapper}>
				<Picker
					selectedValue={category}
					onValueChange={(value) => setCategory(value)}
					style={{
						color: theme.colors.textPrimary,
						backgroundColor: theme.colors.card,
					}}
					dropdownIconColor={theme.colors.textPrimary}
				>
					<Picker.Item label="Select Category" value="" />
					{incomeCategories.map((cat) => (
						<Picker.Item key={cat} label={cat} value={cat} />
					))}
				</Picker>
			</View>

			{/* PAYMENT TYPE */}
			<Text style={styles.label}>Payment Type</Text>
			<View style={styles.paymentRow}>
				{PAYMENT_OPTIONS.map((p) => (
					<TouchableOpacity
						key={p}
						style={[
							styles.paymentButton,
							paymentType === p && styles.paymentActive,
						]}
						onPress={() => setPaymentType(p)}
					>
						<Text
							style={[
								styles.paymentText,
								{
									color: paymentType === p ? "#fff" : theme.colors.textPrimary,
								},
							]}
						>
							{p.toUpperCase()}
						</Text>
					</TouchableOpacity>
				))}
			</View>

			{/* NOTE */}
			<Text style={styles.label}>Note</Text>
			<TextInput
				style={[styles.input, { height: 80 }]}
				placeholder="Optional note"
				value={note}
				onChangeText={setNote}
				placeholderTextColor={theme.colors.textSecondary}
				multiline
			/>

			{/* SAVE */}
			<TouchableOpacity style={styles.saveButton} onPress={handleSave}>
				<Text style={styles.saveButtonText}>
					{isEditMode ? "Update Entry" : "Save Entry"}
				</Text>
			</TouchableOpacity>
		</>
	);
}
