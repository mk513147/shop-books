import React, { useState, useCallback, useEffect, useRef } from "react";
import {
	View,
	Text,
	TouchableOpacity,
	ScrollView,
	KeyboardAvoidingView,
	Platform,
} from "react-native";
import { useRoute, RouteProp, useFocusEffect } from "@react-navigation/native";

import { styles } from "@screens/AddEntryScreen/AddEntry.styles";
import { theme } from "@theme";
import { RootStackParamList } from "@navigation/types";

import IncomeForm from "@components/IncomeForm";
import ExpenseForm from "@components/ExpenseForm";
import DraggableBottomSheet from "@components/DraggableBottomSheet";

import { getTransactionsByDate } from "@database/transactionService";
import ConfirmDiscardModal from "@components/ConfirmDiscardModal";
import { useNavigation } from "@react-navigation/native";
import { useToast } from "@context/ToastContext";

type RouteProps = RouteProp<RootStackParamList, "AddEntry">;

export default function AddEntryScreen() {
	const route = useRoute<RouteProps>();
	const editingTransaction = route.params?.transaction ?? null;
	const isEditMode = !!editingTransaction;
	const navigation = useNavigation();
	const { show } = useToast();

	const [isFormDirty, setIsFormDirty] = useState(false);
	const blockedActionRef = useRef<any>(null);

	const [type, setType] = useState<"income" | "expense">(
		editingTransaction?.type ?? "income",
	);

	const [discardAction, setDiscardAction] = useState<
		"navigation" | "type" | null
	>(null);

	const [dailyTransactions, setDailyTransactions] = useState<any[]>([]);
	const [selectedDate, setSelectedDate] = useState(
		editingTransaction?.date ? new Date(editingTransaction.date) : new Date(),
	);

	const [pendingType, setPendingType] = useState<"income" | "expense" | null>(
		null,
	);
	const [showDiscardModal, setShowDiscardModal] = useState(false);

	const formatDate = (date: Date) => {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	const loadDailyTransactions = async () => {
		const formattedDate = formatDate(selectedDate);
		const data = await getTransactionsByDate(formattedDate);
		setDailyTransactions(data);
	};

	useFocusEffect(
		useCallback(() => {
			let isActive = true;

			const load = async () => {
				try {
					const formattedDate = formatDate(selectedDate);
					const data = await getTransactionsByDate(formattedDate);

					if (isActive) {
						setDailyTransactions(data);
					}
				} catch (e) {
					console.error("Load transactions error:", e);
				}
			};

			load();

			return () => {
				isActive = false;
			};
		}, [selectedDate]),
	);

	const incomeList = dailyTransactions.filter((t) => t.type === "income");

	const expenseList = dailyTransactions.filter((t) => t.type === "expense");

	const incomeTotal = incomeList.reduce(
		(sum, t) => sum + Number(t.amount || 0),
		0,
	);

	const expenseTotal = expenseList.reduce(
		(sum, t) => sum + Number(t.amount || 0),
		0,
	);

	const handleTypeChange = (newType: "income" | "expense") => {
		if (newType === type) return;

		if (!isFormDirty) {
			setType(newType);
			return;
		}

		setPendingType(newType);
		setDiscardAction("type");
		setShowDiscardModal(true);
	};
	const confirmDiscard = () => {
		if (discardAction === "navigation" && blockedActionRef.current) {
			setShowDiscardModal(false);
			setIsFormDirty(false);

			show("Changes discarded", "info");

			navigation.dispatch(blockedActionRef.current);
			blockedActionRef.current = null;
		}

		if (discardAction === "type" && pendingType) {
			setShowDiscardModal(false);
			setIsFormDirty(false);

			setType(pendingType);
			setPendingType(null);

			show("Switched entry type", "info");
		}

		setDiscardAction(null);
	};
	const cancelDiscard = () => {
		setShowDiscardModal(false);
		setDiscardAction(null);
		setPendingType(null);
	};

	useEffect(() => {
		const unsubscribe = navigation.addListener("beforeRemove", (e) => {
			if (!isFormDirty) return;

			e.preventDefault();

			blockedActionRef.current = e.data.action;
			setDiscardAction("navigation");
			setShowDiscardModal(true);
		});

		return unsubscribe;
	}, [navigation, isFormDirty]);

	return (
		<View style={styles.container}>
			<KeyboardAvoidingView
				style={styles.formSection}
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				keyboardVerticalOffset={80}
			>
				<ScrollView
					showsVerticalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
					contentContainerStyle={{ paddingBottom: 60 }}
				>
					{/* TOGGLE */}
					<View style={styles.toggleContainer}>
						<TouchableOpacity
							style={[
								styles.toggleButton,
								type === "income" && styles.activeIncome,
							]}
							onPress={() => handleTypeChange("income")}
						>
							<Text
								style={[
									styles.toggleText,
									{
										color:
											type === "income" ? "#fff" : theme.colors.textPrimary,
									},
								]}
							>
								Income
							</Text>
						</TouchableOpacity>

						<TouchableOpacity
							style={[
								styles.toggleButton,
								type === "expense" && styles.activeExpense,
							]}
							onPress={() => handleTypeChange("expense")}
						>
							<Text
								style={[
									styles.toggleText,
									{
										color:
											type === "expense" ? "#fff" : theme.colors.textPrimary,
									},
								]}
							>
								Expense
							</Text>
						</TouchableOpacity>
					</View>

					{/* FORMS */}
					{type === "income" ? (
						<IncomeForm
							editingTransaction={editingTransaction}
							isEditMode={isEditMode}
							onSaveSuccess={loadDailyTransactions}
							setIsFormDirty={setIsFormDirty}
						/>
					) : (
						<ExpenseForm
							editingTransaction={editingTransaction}
							isEditMode={isEditMode}
							onSaveSuccess={loadDailyTransactions}
							setIsFormDirty={setIsFormDirty}
						/>
					)}
				</ScrollView>
			</KeyboardAvoidingView>

			{/* SUMMARY */}
			<DraggableBottomSheet>
				<Text style={styles.panelTitle}>Today's Summary</Text>

				<ScrollView
					showsVerticalScrollIndicator={false}
					contentContainerStyle={{ paddingBottom: 20 }}
				>
					{/* INCOME */}
					{incomeList.length > 0 && (
						<>
							<Text style={styles.subHeading}>Income</Text>

							{incomeList.map((item) => (
								<View key={item.id} style={styles.row}>
									<Text>{item.category}</Text>
									<Text>₹{item.amount}</Text>
								</View>
							))}

							<View style={styles.totalRow}>
								<Text>Total</Text>
								<Text>₹{incomeTotal}</Text>
							</View>
						</>
					)}

					{/* EXPENSE */}
					{expenseList.length > 0 && (
						<>
							<Text style={[styles.subHeading, { marginTop: 16 }]}>
								Expense
							</Text>

							{expenseList.map((item) => (
								<View key={item.id} style={styles.row}>
									<Text>{item.supplierName}</Text>
									<Text>₹{item.amount}</Text>
								</View>
							))}

							<View style={styles.totalRow}>
								<Text>Total</Text>
								<Text>₹{expenseTotal}</Text>
							</View>
						</>
					)}
				</ScrollView>
			</DraggableBottomSheet>
			<ConfirmDiscardModal
				visible={showDiscardModal}
				onCancel={cancelDiscard}
				onConfirm={confirmDiscard}
			/>
		</View>
	);
}
