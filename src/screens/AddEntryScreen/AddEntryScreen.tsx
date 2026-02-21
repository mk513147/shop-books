import React, { useState, useCallback } from "react";
import { View, Text, TouchableOpacity, ScrollView } from "react-native";
import { useRoute, RouteProp, useFocusEffect } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";

import { styles } from "@screens/AddEntryScreen/AddEntry.styles";
import { theme } from "@theme";
import { RootStackParamList } from "@navigation/types";

import IncomeForm from "@components/IncomeForm";
import ExpenseForm from "@components/ExpenseForm";
import DraggableBottomSheet from "@components/DraggableBottomSheet";

import { getTransactionsByDate } from "@database/transactionService";

type RouteProps = RouteProp<RootStackParamList, "AddEntry">;

export default function AddEntryScreen() {
	const route = useRoute<RouteProps>();
	const editingTransaction = route.params?.transaction ?? null;
	const isEditMode = !!editingTransaction;

	const [type, setType] = useState<"income" | "expense">(
		editingTransaction?.type ?? "income",
	);

	const [dailyTransactions, setDailyTransactions] = useState<any[]>([]);
	const [selectedDate, setSelectedDate] = useState(
		editingTransaction?.date ? new Date(editingTransaction.date) : new Date(),
	);

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
			loadDailyTransactions();
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

	return (
		<View style={styles.container}>
			<View style={styles.formSection}>
				<ScrollView
					showsVerticalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
					contentContainerStyle={{ paddingBottom: 90 }}
				>
					{/* TOGGLE */}
					<View style={styles.toggleContainer}>
						<TouchableOpacity
							style={[
								styles.toggleButton,
								type === "income" && styles.activeIncome,
							]}
							onPress={() => setType("income")}
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
							onPress={() => setType("expense")}
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
						/>
					) : (
						<ExpenseForm
							editingTransaction={editingTransaction}
							isEditMode={isEditMode}
							onSaveSuccess={loadDailyTransactions}
						/>
					)}
				</ScrollView>
			</View>

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
		</View>
	);
}
