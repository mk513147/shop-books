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
import { useFormDirty } from "src/hooks/useFormDirty";
type NavigationProp = NativeStackNavigationProp<RootStackParamList, "AddEntry">;

type Props = {
	editingTransaction: any;
	isEditMode: boolean;
	onSaveSuccess: () => void;
	setIsFormDirty: (value: boolean) => void;
};

export default function IncomeForm({
	editingTransaction,
	isEditMode,
	onSaveSuccess,
	setIsFormDirty,
}: Props) {
	const navigation = useNavigation<NavigationProp>();
	const { show } = useToast();
	const initialValues = {
		amount: editingTransaction?.amount?.toString() ?? "",
		category: editingTransaction?.category ?? "",
		paymentType: editingTransaction?.paymentType ?? "cash",
		note: editingTransaction?.note ?? "",
		date: editingTransaction?.date
			? new Date(editingTransaction.date)
			: new Date(),
	};
	const [showDatePicker, setShowDatePicker] = useState(false);

	const [formValues, setFormValues] = useState(initialValues);

	const { isDirty, resetDirty } = useFormDirty(formValues);

	const handleChange = (key: keyof typeof formValues, value: any) => {
		setFormValues((prev) => ({
			...prev,
			[key]: value,
		}));
	};

	useEffect(() => {
		setIsFormDirty(isDirty);
	}, [isDirty]);

	const formatDate = (date: Date) => {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	useEffect(() => {
		if (!editingTransaction) return;

		const updatedValues = {
			amount: editingTransaction.amount?.toString() ?? "",
			category: editingTransaction.category ?? "",
			paymentType: editingTransaction.paymentType ?? "cash",
			note: editingTransaction.note ?? "",
			date: new Date(editingTransaction.date),
		};

		setFormValues(updatedValues);
		resetDirty(updatedValues);
	}, [editingTransaction]);

	const handleSave = async () => {
		try {
			if (!formValues.amount || !formValues.category) {
				show("Amount and Category are required", "info");
				return;
			}

			const numericAmount = Number(formValues.amount.trim());

			if (
				!Number.isFinite(numericAmount) ||
				numericAmount <= 0 ||
				numericAmount > 20000
			) {
				show("Enter a valid amount", "warning");
				return;
			}

			const formattedDate = formatDate(formValues.date);
			if (!isEditMode) {
				const count = await getDailyTransactionCount(formattedDate, "income");

				if (count >= 12) {
					show("Maximum 12 income entries allowed per day.", "warning");
					return;
				}
			}

			const existingCategory = await checkIncomeCategorySameDay(
				formattedDate,
				formValues.category,
				editingTransaction?.id,
			);

			if (existingCategory) {
				show(
					`${formValues.category.toUpperCase()} already exists for this date.`,
					"warning",
				);
				return;
			}

			const payload: TransactionInput = {
				type: "income",
				amount: numericAmount,
				category: formValues.category,
				note: formValues.note || null,
				date: formattedDate,
				paymentType: formValues.paymentType,
				supplierId: null,
				imagePath: null,
			};

			if (isEditMode) {
				await updateTransaction(editingTransaction.id, payload);
				onSaveSuccess();
				show("Transaction Updated", "success");
				resetDirty();
				setIsFormDirty(false);
				navigation.goBack();
			} else {
				await addTransaction(payload);
				show("Transaction Saved", "success");
				onSaveSuccess();
				resetDirty();
				setIsFormDirty(false);
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
				<Text>{formatDate(formValues.date)}</Text>
			</TouchableOpacity>

			{showDatePicker && (
				<DateTimePicker
					value={formValues.date}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(event, date) => {
						setShowDatePicker(false);
						if (date) handleChange("date", date);
					}}
				/>
			)}

			{/* AMOUNT */}
			<Text style={styles.label}>Amount</Text>
			<TextInput
				style={styles.amountInput}
				keyboardType="numeric"
				placeholder="₹ 0.00"
				value={formValues.amount}
				onChangeText={(val) => handleChange("amount", val)}
				placeholderTextColor={theme.colors.textSecondary}
			/>

			{/* CATEGORY */}
			<Text style={styles.label}>Category</Text>
			<View style={styles.pickerWrapper}>
				<Picker
					selectedValue={formValues.category}
					onValueChange={(value) => handleChange("category", value)}
					style={{
						color: theme.colors.textPrimary,
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
							formValues.paymentType === p && styles.paymentActive,
						]}
						onPress={() => handleChange("paymentType", p)}
					>
						<Text
							style={[
								styles.paymentText,
								{
									color:
										formValues.paymentType === p
											? "#fff"
											: theme.colors.textPrimary,
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
				value={formValues.note}
				onChangeText={(val) => handleChange("note", val)}
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
