import React, { useState } from "react";
import { View, Text, FlatList, TouchableOpacity, Image } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Platform } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { getTransactionsByDateRange } from "../../database/transactionService";

import { theme } from "../../theme";
import { styles } from "./Transactions.styles";
import ImageViewer from "@components/ImageViewer/ImageViewer";
import ImageGrid from "@components/ImageGrid/ImageGrid";

type Transaction = {
	id: number;
	type: "income" | "expense";
	amount: number;
	category: string;
	note?: string;
	date: string;
	paymentType: string;
	supplierId?: number | null;
	supplierName?: string | null;
	imagePath?: string | null;
	createdAt?: string;
};

export default function TransactionsScreen() {
	const today = new Date();

	const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

	const [fromDate, setFromDate] = useState(firstDayOfMonth);
	const [toDate, setToDate] = useState(today);

	const [showFromPicker, setShowFromPicker] = useState(false);
	const [showToPicker, setShowToPicker] = useState(false);

	const [transactions, setTransactions] = useState<Transaction[]>([]);

	const [viewerVisible, setViewerVisible] = useState(false);
	const [viewerImages, setViewerImages] = useState<string[]>([]);
	const [currentIndex, setCurrentIndex] = useState(0);

	const formatDate = (date: Date) => {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	const openViewer = (images: string[], index: number) => {
		setViewerImages(images);
		setCurrentIndex(index);
		setViewerVisible(true);
	};

	const loadTransactions = async () => {
		const from = formatDate(fromDate);
		const to = formatDate(toDate);

		const data = await getTransactionsByDateRange(from, to);

		setTransactions(data as Transaction[]);
	};

	useFocusEffect(
		useCallback(() => {
			loadTransactions();
		}, [fromDate, toDate]),
	);

	const renderItem = ({ item }: { item: Transaction }) => {
		return (
			<View style={styles.card}>
				<View style={styles.rowTop}>
					<Text
						style={[
							theme.typography.bodyLarge,
							{
								color:
									item.type === "income"
										? theme.colors.income
										: theme.colors.expense,
							},
						]}
					>
						₹ {item.amount}
					</Text>

					<Text style={styles.dateText}>{item.date}</Text>
				</View>

				<Text style={styles.category}>{item.category}</Text>

				{item.supplierName && (
					<Text style={styles.supplier}>Supplier: {item.supplierName}</Text>
				)}

				{/* IMAGE GRID */}
				{item.imagePath && (
					<ImageGrid
						imagePath={item.imagePath || ""}
						onPressImage={openViewer}
					/>
				)}

				<View style={styles.rowBottom}>
					<Text style={styles.paymentBadge}>
						{item.paymentType.toUpperCase()}
					</Text>
				</View>
			</View>
		);
	};

	return (
		<View style={styles.container}>
			{/* FILTER SECTION */}
			<View style={styles.filterContainer}>
				<TouchableOpacity onPress={() => setShowFromPicker(true)}>
					<Text style={styles.filterText}>From: {formatDate(fromDate)}</Text>
				</TouchableOpacity>

				<TouchableOpacity onPress={() => setShowToPicker(true)}>
					<Text style={styles.filterText}>To: {formatDate(toDate)}</Text>
				</TouchableOpacity>
				<TouchableOpacity
					onPress={() => {
						setFromDate(firstDayOfMonth);
						setToDate(new Date());
					}}
				>
					<Text style={{ color: theme.colors.primary }}>This Month</Text>
				</TouchableOpacity>
			</View>

			<FlatList
				data={transactions}
				keyExtractor={(item) => item.id.toString()}
				renderItem={renderItem}
				contentContainerStyle={{ paddingBottom: 20 }}
			/>

			<ImageViewer
				visible={viewerVisible}
				images={viewerImages}
				currentIndex={currentIndex}
				onClose={() => setViewerVisible(false)}
				onPrev={() => setCurrentIndex((prev) => prev - 1)}
				onNext={() => setCurrentIndex((prev) => prev + 1)}
			/>

			{showFromPicker && (
				<DateTimePicker
					value={fromDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(event, selectedDate) => {
						setShowFromPicker(false);
						if (selectedDate) setFromDate(selectedDate);
					}}
				/>
			)}

			{showToPicker && (
				<DateTimePicker
					value={toDate}
					mode="date"
					display={Platform.OS === "ios" ? "spinner" : "default"}
					onChange={(event, selectedDate) => {
						setShowToPicker(false);
						if (selectedDate) setToDate(selectedDate);
					}}
				/>
			)}
		</View>
	);
}
