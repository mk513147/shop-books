import React from "react";
import { View, Text, ScrollView } from "react-native";
import { theme } from "@theme";
import { styles } from "./DashBoard.styles";
import FloatingButton from "@components/FloatingButton";

export default function DashboardScreen() {
	const todayIncome = 12500;
	const todayExpense = 5200;
	const todayProfit = todayIncome - todayExpense;

	const monthIncome = 245000;
	const monthExpense = 180000;
	const monthProfit = monthIncome - monthExpense;

	const todayDate = new Date().toLocaleDateString();

	return (
		<ScrollView
			contentContainerStyle={styles.container}
			keyboardShouldPersistTaps="handled"
		>
			<View style={{ flex: 1 }}>
				<View>
					{/* DATE */}
					<Text style={styles.dateText}>{todayDate}</Text>

					{/* TODAY SECTION */}
					<Text style={styles.sectionTitle}>Today</Text>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Income</Text>
						<Text style={[styles.value, { color: theme.colors.income }]}>
							₹ {todayIncome}
						</Text>
					</View>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Expense</Text>
						<Text style={[styles.value, { color: theme.colors.expense }]}>
							₹ {todayExpense}
						</Text>
					</View>

					<View style={styles.profitCard}>
						<Text style={styles.label}>Profit</Text>
						<Text
							style={[
								styles.bigValue,
								{
									color:
										todayProfit >= 0
											? theme.colors.income
											: theme.colors.expense,
								},
							]}
						>
							₹ {todayProfit}
						</Text>
					</View>

					{/* MONTH SECTION */}
					<Text style={[styles.sectionTitle, { marginTop: 24 }]}>
						This Month
					</Text>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Income</Text>
						<Text style={[styles.value, { color: theme.colors.income }]}>
							₹ {monthIncome}
						</Text>
					</View>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Expense</Text>
						<Text style={[styles.value, { color: theme.colors.expense }]}>
							₹ {monthExpense}
						</Text>
					</View>

					<View style={styles.summaryCard}>
						<Text style={styles.label}>Profit</Text>
						<Text
							style={[
								styles.value,
								{
									color:
										monthProfit >= 0
											? theme.colors.income
											: theme.colors.expense,
								},
							]}
						>
							₹ {monthProfit}
						</Text>
					</View>
				</View>

				<FloatingButton />
			</View>
		</ScrollView>
	);
}
