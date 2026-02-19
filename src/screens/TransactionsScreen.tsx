import React, { useState } from "react";
import {
	View,
	Text,
	StyleSheet,
	FlatList,
	TouchableOpacity,
	Image,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Platform } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { getTransactionsByDateRange } from "../database/transactionService";
import { Modal, Dimensions } from "react-native";

import { theme } from "../theme";

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
					<View style={styles.thumbnailRow}>
						{(() => {
							const images = JSON.parse(item.imagePath || "[]");
							const visibleImages = images.slice(0, 5);
							const remaining = images.length - 5;

							return visibleImages.map((img: string, index: number) => {
								const isLastVisible = index === 4 && remaining > 0;

								return (
									<TouchableOpacity
										key={index}
										onPress={() => openViewer(images, index)}
									>
										<View style={styles.thumbnailWrapper}>
											<Image source={{ uri: img }} style={styles.thumbnail} />

											{isLastVisible && (
												<View style={styles.overlay}>
													<Text style={styles.overlayText}>+{remaining}</Text>
												</View>
											)}
										</View>
									</TouchableOpacity>
								);
							});
						})()}
					</View>
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

			<Modal visible={viewerVisible} transparent>
				<View style={styles.viewerContainer}>
					<Image
						source={{ uri: viewerImages[currentIndex] }}
						style={styles.viewerImage}
						resizeMode="contain"
					/>

					{/* Close Button */}
					<TouchableOpacity
						style={styles.closeButton}
						onPress={() => setViewerVisible(false)}
					>
						<Text style={{ color: "#fff", fontSize: 18 }}>✕</Text>
					</TouchableOpacity>

					{/* Previous */}
					{currentIndex > 0 && (
						<TouchableOpacity
							style={styles.prevButton}
							onPress={() => setCurrentIndex(currentIndex - 1)}
						>
							<Text style={styles.navText}>‹</Text>
						</TouchableOpacity>
					)}

					{/* Next */}
					{currentIndex < viewerImages.length - 1 && (
						<TouchableOpacity
							style={styles.nextButton}
							onPress={() => setCurrentIndex(currentIndex + 1)}
						>
							<Text style={styles.navText}>›</Text>
						</TouchableOpacity>
					)}
				</View>
			</Modal>

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

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: theme.colors.background,
		padding: 16,
	},

	filterContainer: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 16,
		backgroundColor: theme.colors.card,
		padding: 12,
		borderRadius: 8,
	},

	filterText: {
		color: theme.colors.textPrimary,
		fontSize: 14,
	},

	card: {
		backgroundColor: theme.colors.card,
		padding: 14,
		borderRadius: 10,
		marginBottom: 12,
	},

	rowTop: {
		flexDirection: "row",
		justifyContent: "space-between",
	},

	rowBottom: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginTop: 8,
	},

	thumbnailRow: {
		flexDirection: "row",
		marginTop: 8,
	},

	thumbnailWrapper: {
		position: "relative",
		marginRight: 6,
	},

	overlay: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		backgroundColor: "rgba(0,0,0,0.6)",
		justifyContent: "center",
		alignItems: "center",
		borderRadius: 6,
	},

	overlayText: {
		color: "#fff",
		fontWeight: "700",
		fontSize: 16,
	},

	viewerContainer: {
		flex: 1,
		backgroundColor: "rgba(0,0,0,0.95)",
		justifyContent: "center",
		alignItems: "center",
	},

	viewerImage: {
		width: Dimensions.get("window").width,
		height: Dimensions.get("window").height * 0.7,
	},

	closeButton: {
		position: "absolute",
		top: 50,
		right: 20,
	},

	prevButton: {
		position: "absolute",
		left: 20,
		top: "50%",
	},

	nextButton: {
		position: "absolute",
		right: 20,
		top: "50%",
	},

	navText: {
		color: "#fff",
		fontSize: 40,
		fontWeight: "bold",
	},

	dateText: {
		color: theme.colors.textSecondary,
		fontSize: 13,
	},

	category: {
		marginTop: 4,
		fontWeight: "600",
		color: theme.colors.textPrimary,
	},

	supplier: {
		marginTop: 2,
		color: theme.colors.textSecondary,
		fontSize: 13,
	},

	paymentBadge: {
		paddingHorizontal: 10,
		paddingVertical: 4,
		backgroundColor: theme.colors.primary,
		color: "#fff",
		borderRadius: 6,
		fontSize: 12,
	},

	thumbnail: {
		width: 40,
		height: 40,
		borderRadius: 6,
	},
});
